import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { runTool, ToolRuntime } from "../src/tools/index.js";
import { cssEdit, isDangerousCssEdit, splitImportant } from "../src/tools/css-edit.js";
import { dangerousFor } from "../src/tools/tool-traits.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const TEXT = (result: { content: unknown }) => JSON.stringify(result.content);

const readOnly: Config = {
    ...managedConfig,
    safety: { ...managedConfig.safety, readOnly: true },
};

const restricted: Config = {
    ...managedConfig,
    safety: { ...managedConfig.safety, allowedDomains: ["example.com"] },
};

function runtimeOf(fake: FakeAccess, config: Config = managedConfig): ToolRuntime {
    const runtime = new ToolRuntime({ access: fake.asAccess(), config });

    runtime.tabs.select("tab1");

    return runtime;
}

function editFake(options: {
    url?      : string;
    origin?   : string;
    state?    : Record<string, unknown>;
    value?    : Record<string, unknown>;
    exception?: boolean;
} = {}): FakeAccess {
    const fake = new FakeAccess({
        tabs: [{
            targetId: "tab1",
            url     : options.url ?? "https://example.com/",
            title   : "t",
            owned   : true,
            created : true,
        }],
    });

    fake.respond = (_targetId, method, params) => {
        switch (method) {
            case "DOM.getDocument":
                return { root: { nodeId: 1 } };
            case "DOM.querySelector":
                return { nodeId: 11 };
            case "DOM.resolveNode":
                return { object: { objectId: "obj-11" } };
            case "DOM.describeNode":
                return { node: { backendNodeId: 101 } };
            case "DOM.scrollIntoViewIfNeeded":
            case "Runtime.releaseObject":
                return {};
            case "DOM.enable":
                return {};
            case "DOM.performSearch":
                return { searchId: "s1", resultCount: 1 };
            case "DOM.getSearchResults":
                return { nodeIds: [11] };
            case "DOM.discardSearchResults":
                return {};
            case "Runtime.evaluate":
                return { result: { type: "string", value: options.url ?? "https://example.com/" } };

            case "Runtime.callFunctionOn": {
                const declaration = String(
                    (params as { functionDeclaration?: unknown }).functionDeclaration ?? "",
                );

                if (declaration.includes("defaultView.origin")) {
                    return { result: { type: "string", value: options.origin ?? "https://example.com" } };
                }

                if (declaration.includes("localName")) {
                    return {
                        result: {
                            type : "object",
                            value: {
                                tag       : "div",
                                id        : "",
                                classes   : [],
                                disabled  : false,
                                connected : true,
                                editable  : "none",
                                selectable: false,
                                fileInput : false,
                                ...options.state,
                            },
                        },
                    };
                }

                if (options.exception === true) {
                    return { result: { type: "object" }, exceptionDetails: { text: "nope" } };
                }

                return {
                    result: {
                        type : "object",
                        value: options.value ?? { previous: { color: "" }, computed: { color: "red" } },
                    },
                };
            }

            default:
                throw new Error(`unexpected CDP call ${method}`);
        }
    };

    return fake;
}

describe("css_edit input schema", () => {
    const accepts = (value: unknown) => cssEdit.input.safeParse(value).success;

    it("accepts every action with its fields and rejects the rest", () => {
        expect(accepts({ target: { selector: "a" }, action: "set_style", declarations: { color: "red" } })).toBe(true);
        expect(accepts({ target: { selector: "a" }, action: "add_rule", selector: ".x", declarations: { color: "red" } })).toBe(true);
        expect(accepts({ target: { selector: "a" }, action: "remove_rule", ruleId: "0" })).toBe(true);
        expect(accepts({ target: { selector: "a" }, action: "set_style", declarations: { "--brand": "red" } })).toBe(true);
        expect(accepts({ target: { selector: "a" }, action: "set_style", declarations: { color: "red !important" } })).toBe(true);
        expect(accepts({ target: { selector: "a" }, action: "remove_rule" })).toBe(false);
        expect(accepts({ target: { selector: "a" }, action: "set_style", declarations: {} })).toBe(false);
        expect(accepts({ target: { selector: "a" }, action: "set_style", declarations: { "bad name": "red" } })).toBe(false);
        expect(accepts({ target: { selector: "a" }, action: "set_style", declarations: { color: "red" }, selector: ".x" })).toBe(false);
        expect(accepts({ target: { selector: "a" }, action: "add_rule", declarations: { color: "red" } })).toBe(false);
    });
});

describe("splitImportant", () => {
    it("splits a trailing important marker from the value", () => {
        expect(splitImportant("red !important")).toEqual({ value: "red", important: true });
        expect(splitImportant("RED!important")).toEqual({ value: "RED", important: true });
        expect(splitImportant("red")).toEqual({ value: "red", important: false });
        expect(splitImportant("")).toEqual({ value: "", important: false });
    });
});

describe("css_edit", () => {
    it("is a mutate tool and never dangerous", () => {
        expect(cssEdit.access).toBe("mutate");
        expect(dangerousFor(cssEdit, { action: "set_style" })).toBe(false);
        expect(dangerousFor(cssEdit, { action: "add_rule" })).toBe(false);
        expect(dangerousFor(cssEdit, { action: "remove_rule" })).toBe(false);
    });

    it("edits inline styles through Runtime.callFunctionOn and reports previous and computed values", async () => {
        const fake = editFake();
        const result = await runTool(
            cssEdit,
            { target: { selector: "#a" }, action: "set_style", declarations: { color: "red" } },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            ok      : true,
            action  : "set_style",
            previous: { color: "" },
            computed: { color: "red" },
        });

        const request = (fake.sent.filter((call) => call.method === "Runtime.callFunctionOn")
            .at(-1)?.params as { arguments?: Array<{ value?: unknown }> })
            ?.arguments?.[1]?.value as { declarations?: unknown };

        expect(request).toEqual({
            declarations: [{ name: "color", value: "red", important: false }],
        });
        expect(fake.sent.map((call) => call.method)).not.toContain("CSS.setStyleTexts");
    });

    it("adds a rule into a tagged style element and returns its id", async () => {
        const fake = editFake({ value: { ruleId: "cdm-1", selector: ".x", applied: { color: "red" } } });
        const result = await runTool(
            cssEdit,
            { target: { selector: "#a" }, action: "add_rule", selector: ".x", declarations: { color: "red" } },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            ok      : true,
            action  : "add_rule",
            ruleId  : "cdm-1",
            selector: ".x",
        });

        const call = fake.sent.filter((call) => call.method === "Runtime.callFunctionOn").at(-1);
        const declaration = String(
            (call?.params as { functionDeclaration?: unknown })?.functionDeclaration ?? "",
        );
        const request = (call?.params as { arguments?: Array<{ value?: unknown }> })
            ?.arguments?.[1]?.value as { selector?: string; ruleId?: string };

        expect(declaration).toContain("insertRule");
        expect(request?.selector).toBe(".x");
        expect(typeof request?.ruleId).toBe("string");

        const second = await runTool(
            cssEdit,
            { target: { selector: "#a" }, action: "add_rule", selector: ".y", declarations: { color: "blue" } },
            extra(),
            runtimeOf(fake),
        );

        expect(second.isError).not.toBe(true);

        const calls = fake.sent.filter((call) => call.method === "Runtime.callFunctionOn");
        const firstId = (calls.at(-2)?.params as { arguments?: Array<{ value?: unknown }> })
            ?.arguments?.[1]?.value as { ruleId?: string };
        const secondId = (calls.at(-1)?.params as { arguments?: Array<{ value?: unknown }> })
            ?.arguments?.[1]?.value as { ruleId?: string };

        expect(firstId?.ruleId).not.toBe(secondId?.ruleId);
    });

    it("removes a rule by id and reports a missing rule without an error", async () => {
        const removed = editFake({ value: { removed: true, selector: ".x" } });
        const kept = editFake({ value: { removed: false, selector: "" } });

        const gone = await runTool(
            cssEdit,
            { target: { selector: "#a" }, action: "remove_rule", ruleId: "0" },
            extra(),
            runtimeOf(removed),
        );
        const missing = await runTool(
            cssEdit,
            { target: { selector: "#a" }, action: "remove_rule", ruleId: "7" },
            extra(),
            runtimeOf(kept),
        );

        expect(gone.structuredContent).toMatchObject({ ok: true, removed: true, selector: ".x" });
        expect(missing.isError).not.toBe(true);
        expect(missing.structuredContent).toMatchObject({ ok: false, removed: false });
        expect(TEXT(missing)).toContain("already have been removed");
    });

    it("refuses a rule over the character limit without touching the page scripts", async () => {
        const fake = editFake();
        const declarations: Record<string, string> = {};

        for (let i = 0; i < 6; i += 1) declarations[`--prop-${i}`] = "x".repeat(4000);

        const result = await runTool(
            cssEdit,
            { target: { selector: "#a" }, action: "add_rule", selector: ".x", declarations },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).toBe(true);
        expect(TEXT(result)).toContain("character limit");

        const declaration = String(
            ((fake.sent.filter((call) => call.method === "Runtime.callFunctionOn").at(-1)?.params) as { functionDeclaration?: unknown })?.functionDeclaration ?? "",
        );

        expect(fake.sent.map((call) => call.method)).not.toContain("CSS.insertStyleSheet");
        expect(declaration).not.toContain("insertRule");
    });

    it("truncates long previous values with an explicit marker", async () => {
        const fake = editFake({
            value: { previous: { color: "x".repeat(25000) }, computed: { color: "red" } },
        });
        const result = await runTool(
            cssEdit,
            { target: { selector: "#a" }, action: "set_style", declarations: { color: "red" } },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).not.toBe(true);
        expect(TEXT(result)).toContain("[truncated:");
        expect(result.structuredContent).toMatchObject({ truncated: true, totalLength: 25000 });
    });

    it("reports an invalid selector without leaking page content", async () => {
        const fake = editFake({ value: { error: "selector" } });
        const result = await runTool(
            cssEdit,
            { target: { selector: "#a" }, action: "add_rule", selector: "@media print", declarations: { color: "red" } },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).toBe(true);
        expect(TEXT(result)).toContain("not a style rule selector");
        expect(TEXT(result)).toContain("Nothing was added");
        expect(TEXT(result)).not.toContain("innerHTML");
    });

    it("names the declarations the browser did not accept and says nothing was added", async () => {
        const fake = editFake({ value: { error: "declaration", rejected: ["colr"] } });
        const result = await runTool(
            cssEdit,
            { target: { selector: "#a" }, action: "add_rule", selector: ".x", declarations: { colr: "red" } },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).toBe(true);
        expect(TEXT(result)).toContain("did not accept colr");
        expect(TEXT(result)).toContain("Nothing was added");
    });

    it("explains a page that does not take a style tag", async () => {
        const fake = editFake({ value: { error: "sheet" } });
        const result = await runTool(
            cssEdit,
            { target: { selector: "#a" }, action: "add_rule", selector: ".x", declarations: { color: "red" } },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).toBe(true);
        expect(TEXT(result)).toContain("Content-Security-Policy");
    });

    it("reports a style the browser did not accept and changed nothing", async () => {
        const fake = editFake({ value: { rejected: ["foo"] } });
        const result = await runTool(
            cssEdit,
            { target: { selector: "#a" }, action: "set_style", declarations: { foo: "bar" } },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).toBe(true);
        expect(TEXT(result)).toContain("did not accept foo");
        expect(TEXT(result)).toContain("Nothing was changed");
    });

    it("refuses a property named twice with different case", async () => {
        const result = await runTool(
            cssEdit,
            { target: { selector: "#a" }, action: "set_style", declarations: { Color: "red", color: "blue" } },
            extra(),
            runtimeOf(editFake()),
        );

        expect(result.isError).toBe(true);
        expect(TEXT(result)).toContain("Each property may appear once");
    });

    it("is refused in read-only mode before touching the page", async () => {
        const fake = editFake();
        const result = await runTool(
            cssEdit,
            { target: { selector: "#a" }, action: "set_style", declarations: { color: "red" } },
            extra(),
            runtimeOf(fake, readOnly),
        );

        expect(result.isError).toBe(true);
        expect(TEXT(result)).toContain("read-only mode");
        expect(fake.sent).toEqual([]);
    });

    it("is refused on a tab outside the allowlist", async () => {
        const fake = editFake({ url: "https://evil.test/" });
        const result = await runTool(
            cssEdit,
            { target: { selector: "#a" }, action: "set_style", declarations: { color: "red" } },
            extra(),
            runtimeOf(fake, restricted),
        );

        expect(result.isError).toBe(true);
        expect(TEXT(result)).toContain("outside safety.allowedDomains");
        expect(fake.sent).toEqual([]);
    });

    it("is refused for an element whose document is outside the allowlist", async () => {
        const fake = editFake({ origin: "https://evil.test" });
        const result = await runTool(
            cssEdit,
            { target: { selector: "#a", pierce: true }, action: "set_style", declarations: { color: "red" } },
            extra(),
            runtimeOf(fake, restricted),
        );

        expect(result.isError).toBe(true);
        expect(TEXT(result)).toContain("outside safety.allowedDomains");
    });
});

describe("isDangerousCssEdit", () => {
    it("is dangerous only when a value makes the page fetch an address", () => {
        expect(isDangerousCssEdit({ declarations: { color: "red" } })).toBe(false);
        expect(isDangerousCssEdit({ declarations: { background: "url(//x.test/y)" } })).toBe(true);
        expect(isDangerousCssEdit({ declarations: { "border-image": "image-set(\"a\" 1x)" } })).toBe(true);
        expect(isDangerousCssEdit({})).toBe(false);
    });

    it("sees a fetching function written with CSS escapes", () => {
        expect(isDangerousCssEdit({ declarations: { background: "\\75rl(http://x.test/a)" } })).toBe(true);
        expect(isDangerousCssEdit({ declarations: { background: "u\\72l(http://x.test/a)" } })).toBe(true);
        expect(isDangerousCssEdit({ declarations: { content: "\\201C" } })).toBe(false);
    });
});
