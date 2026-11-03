import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { fillForm, runTool, ToolRuntime } from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

interface Probe {
    kind    : string;
    checked?: boolean;
    options?: Array<{ value: string; label: string }>;
}

function formFake(probes: Record<string, Probe>): FakeAccess {
    const fake = new FakeAccess({
        tabs: [{ targetId: "tab1", url: "https://a.example/", title: "t", owned: true, created: true }],
    });
    let current = "";

    fake.respond = (_tab, method, params) => {
        switch (method) {
            case "DOM.getDocument":
                return { root: { nodeId: 1 } };

            case "DOM.querySelector":
                current = String((params as { selector?: unknown }).selector);

                return { nodeId: 11 };

            case "DOM.resolveNode":
                return { object: { objectId: `obj-${current}` } };

            case "DOM.describeNode":
                return { node: { backendNodeId: 101 } };

            case "DOM.getBoxModel": {
                const quad = [10, 20, 110, 20, 110, 70, 10, 70];

                return { model: { content: quad, padding: quad, border: quad, margin: quad } };
            }

            case "DOM.scrollIntoViewIfNeeded":
            case "DOM.focus":
            case "Emulation.setFocusEmulationEnabled":
            case "Runtime.releaseObject":
                return {};

            case "Runtime.evaluate":
                return { result: { type: "string", value: "https://a.example/" } };

            case "Runtime.callFunctionOn": {
                const declaration = String(
                    (params as { functionDeclaration?: unknown }).functionDeclaration,
                );

                if (declaration.includes('kind: "select"')) {
                    return { result: { value: probes[current] ?? { kind: "other" } } };
                }

                return {
                    result: {
                        type : "object",
                        value: {
                            tag       : "input",
                            id        : "",
                            classes   : [],
                            disabled  : false,
                            connected : true,
                            editable  : "text",
                            selectable: false,
                            fileInput : false,
                        },
                    },
                };
            }

            default:
                throw new Error(`unexpected CDP call ${method}`);
        }
    };

    return fake;
}

function runtimeOf(fake: FakeAccess): ToolRuntime {
    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

    runtime.tabs.select("tab1");

    return runtime;
}

const text = (result: { content: unknown }) => JSON.stringify(result.content);

const field = (selector: string, value: unknown) => ({ target: { selector }, value });

describe("fill_form input schema", () => {
    const accepts = (value: unknown) => fillForm.input.safeParse(value).success;

    it("takes one to thirty fields with a string, boolean or list value", () => {
        expect(accepts({ fields: [field("#a", "x")] })).toBe(true);
        expect(accepts({ fields: [field("#a", true), field("#b", ["x", "y"])] })).toBe(true);
        expect(accepts({ fields: [] })).toBe(false);
        expect(accepts({ fields: Array.from({ length: 31 }, () => field("#a", "x")) })).toBe(false);
        expect(accepts({ fields: [field("#a", 5)] })).toBe(false);
        expect(accepts({ fields: [{ target: { selector: "#a" } }] })).toBe(false);
        expect(accepts({ fields: [{ ...field("#a", "x"), extra: 1 }] })).toBe(false);
    });
});

describe("fill_form", () => {
    it("names the field that failed and the ones that were filled or skipped", async () => {
        const fake = formFake({
            "#a": { kind: "checkbox", checked: true },
            "#b": { kind: "file" },
            "#c": { kind: "checkbox", checked: false },
        });
        const result = await runTool(
            fillForm,
            { fields: [field("#a", true), field("#b", "x"), field("#c", true)] },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("Field 2 of 3");
        expect(text(result)).toContain('selector \\"#b\\"');
        expect(text(result)).toContain("input_upload");
        expect(text(result)).toContain("Field 1 was filled, field 3 was not attempted.");
    });

    it("reports that no field was filled when the first one fails", async () => {
        const fake = formFake({ "#a": { kind: "other" } });
        const result = await runTool(
            fillForm,
            { fields: [field("#a", "x")] },
            extra(),
            runtimeOf(fake),
        );

        expect(text(result)).toContain("Field 1 of 1");
        expect(text(result)).toContain("not a field that takes a value");
        expect(text(result)).toContain("No field was filled.");
    });

    it("touches nothing when the checkbox already has the wanted state", async () => {
        const fake = formFake({ "#a": { kind: "checkbox", checked: true } });
        const result = await runTool(
            fillForm,
            { fields: [field("#a", true)] },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({
            ok    : true,
            filled: 1,
            fields: [{ index: 1, kind: "checkbox", effect: "The box was already checked." }],
        });
        expect(fake.sent.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);
    });

    it.each([
        ["checkbox", "yes", "true or false"],
        ["radio", "yes", "true or false"],
        ["text", true, "a string"],
        ["select", true, "an option value or label"],
    ])("rejects a wrong value for a %s field", async (kind, value, message) => {
        const fake = formFake({ "#a": { kind, checked: false } });
        const result = await runTool(
            fillForm,
            { fields: [field("#a", value)] },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).toBe(true);
        expect(text(result)).toContain(message);
    });

    it("refuses to uncheck a radio button", async () => {
        const fake = formFake({ "#a": { kind: "radio", checked: true } });
        const result = await runTool(
            fillForm,
            { fields: [field("#a", false)] },
            extra(),
            runtimeOf(fake),
        );

        expect(text(result)).toContain("cannot be unchecked");
    });

    it("names the options when a select has none that matches", async () => {
        const fake = formFake({
            "#a": {
                kind   : "select",
                options: [{ value: "r", label: "Red" }, { value: "g", label: "Green" }],
            },
        });
        const result = await runTool(
            fillForm,
            { fields: [field("#a", "blue")] },
            extra(),
            runtimeOf(fake),
        );

        expect(text(result)).toContain('No option has the value or label \\"blue\\"');
        expect(text(result)).toContain('label=\\"Green\\"');
    });

    it("is refused in read-only mode and on a field in a frame outside the allowlist", async () => {
        const fake = formFake({ "#a": { kind: "text" } });
        const readOnly = new ToolRuntime({
            access: fake.asAccess(),
            config: { ...managedConfig, safety: { ...managedConfig.safety, readOnly: true } },
        });

        readOnly.tabs.select("tab1");

        const refused = await runTool(fillForm, { fields: [field("#a", "x")] }, extra(), readOnly);

        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain("read-only mode");

        const framed = new FakeAccess({
            tabs  : [{ targetId: "tab1", url: "https://a.example/", title: "t", owned: true, created: true }],
            frames: [
                { frameId: "main", url: "https://a.example/", name: "", isolated: false },
                {
                    frameId      : "pay",
                    parentFrameId: "main",
                    url          : "https://pay.example/",
                    name         : "pay",
                    isolated     : true,
                },
            ],
        });
        const restricted = new ToolRuntime({
            access: framed.asAccess(),
            config: { ...managedConfig, safety: { ...managedConfig.safety, allowedDomains: ["a.example"] } },
        });

        restricted.tabs.select("tab1");

        const outside = await runTool(
            fillForm,
            { fields: [field("#a", "x"), { target: { selector: "#b", frame: "pay" }, value: "y" }] },
            extra(),
            restricted,
        );

        expect(outside.isError).toBe(true);
        expect(text(outside)).toContain("pay.example");
        expect(framed.sent).toEqual([]);
    });
});
