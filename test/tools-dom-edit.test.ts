import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { runTool, ToolRuntime } from "../src/tools/index.js";
import { domEdit } from "../src/tools/dom-edit.js";
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

                if (declaration.includes("ownerDocument.defaultView")) {
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

                return { result: { type: "object", value: options.value ?? { previous: "old" } } };
            }

            default:
                throw new Error(`unexpected CDP call ${method}`);
        }
    };

    return fake;
}

describe("dom_edit input schema", () => {
    const accepts = (value: unknown) => domEdit.input.safeParse(value).success;

    it("accepts every action with its fields and rejects the rest", () => {
        expect(accepts({ target: { selector: "a" }, action: "set_attribute", name: "href", value: "x" })).toBe(true);
        expect(accepts({ target: { selector: "a" }, action: "remove_attribute", name: "href" })).toBe(true);
        expect(accepts({ target: { selector: "a" }, action: "set_text", text: "hi" })).toBe(true);
        expect(accepts({ target: { selector: "a" }, action: "set_html", html: "<b>x</b>" })).toBe(true);
        expect(accepts({ target: { selector: "a" }, action: "remove" })).toBe(true);
        expect(accepts({ target: { selector: "a" }, action: "add_class", className: "on" })).toBe(true);
        expect(accepts({ target: { selector: "a" }, action: "remove_class", className: "on" })).toBe(true);
        expect(accepts({ target: { selector: "a" }, action: "toggle_class", className: "on" })).toBe(true);
        expect(accepts({ target: { selector: "a" }, action: "remove", html: "x" })).toBe(false);
        expect(accepts({ target: { selector: "a" }, action: "set_text" })).toBe(false);
        expect(accepts({ target: { selector: "a" }, action: "set_attribute", name: "bad name", value: "x" })).toBe(false);
        expect(accepts({ target: { selector: "a" }, action: "add_class", className: "two words" })).toBe(false);
        expect(accepts({ target: { selector: "a" }, action: "unknown" })).toBe(false);
    });
});

describe("dom_edit", () => {
    it("is a mutate tool and only set_html and remove are dangerous", () => {
        expect(domEdit.access).toBe("mutate");
        expect(dangerousFor(domEdit, { action: "set_html" })).toBe(true);
        expect(dangerousFor(domEdit, { action: "remove" })).toBe(true);
        expect(dangerousFor(domEdit, { action: "set_text" })).toBe(false);
        expect(dangerousFor(domEdit, { action: "set_attribute" })).toBe(false);
        expect(dangerousFor(domEdit, { action: "remove_attribute" })).toBe(false);
        expect(dangerousFor(domEdit, { action: "add_class" })).toBe(false);
    });

    it("edits through Runtime.callFunctionOn and reports the previous value", async () => {
        const fake = editFake();
        const result = await runTool(
            domEdit,
            { target: { selector: "#a" }, action: "set_attribute", name: "title", value: "new" },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            ok       : true,
            action   : "set_attribute",
            attribute: "title",
            previous : "old",
        });
        expect(TEXT(result)).toContain("was set");

        const edit = fake.sent.filter((call) => call.method === "Runtime.callFunctionOn");
        const request = (edit.at(-1)?.params as { arguments?: Array<{ value?: unknown }> })
            ?.arguments?.[1]?.value as { action?: string; name?: string; value?: string };

        expect(request).toEqual({ action: "set_attribute", name: "title", value: "new" });
        expect(fake.sent.map((call) => call.method)).not.toContain("DOM.setAttributeValue");
    });

    it("sends no unexpected CDP methods and releases the element", async () => {
        const fake = editFake();
        const result = await runTool(
            domEdit,
            { target: { selector: "#a" }, action: "add_class", className: "on" },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).not.toBe(true);

        const methods = new Set(fake.sent.map((call) => call.method));

        expect([...methods].sort()).toEqual([
            "DOM.describeNode",
            "DOM.getDocument",
            "DOM.querySelector",
            "DOM.resolveNode",
            "Page.enable",
            "Runtime.callFunctionOn",
            "Runtime.releaseObject",
        ]);
    });

    it("truncates a long previous value with an explicit marker", async () => {
        const fake = editFake({ value: { previous: "x".repeat(25000) } });
        const result = await runTool(
            domEdit,
            { target: { selector: "#a" }, action: "set_text", text: "new" },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).not.toBe(true);
        expect(TEXT(result)).toContain("[truncated:");
        expect(result.structuredContent).toMatchObject({ truncated: true, totalLength: 25000 });
    });

    it("refuses a detached element without running the edit", async () => {
        const fake = editFake({ state: { connected: false } });
        const result = await runTool(
            domEdit,
            { target: { selector: "#a" }, action: "remove" },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).toBe(true);
        expect(TEXT(result)).toContain("no longer attached");
        expect(
            fake.sent.filter((call) =>
                call.method === "Runtime.callFunctionOn" &&
                !String((call.params as { functionDeclaration?: unknown })?.functionDeclaration ?? "")
                    .includes("localName") &&
                !String((call.params as { functionDeclaration?: unknown })?.functionDeclaration ?? "")
                    .includes("ownerDocument.defaultView")),
        ).toEqual([]);
    });

    it("reports a page exception as a tool error without page content", async () => {
        const fake = editFake({ exception: true });
        const result = await runTool(
            domEdit,
            { target: { selector: "#a" }, action: "set_html", html: "<b>x</b>" },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).toBe(true);
        expect(TEXT(result)).toContain("could not apply the edit");
        expect(TEXT(result)).not.toContain("<b>x</b>");
    });

    it("is refused in read-only mode before touching the page", async () => {
        const fake = editFake();
        const result = await runTool(
            domEdit,
            { target: { selector: "#a" }, action: "set_text", text: "new" },
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
            domEdit,
            { target: { selector: "#a" }, action: "set_text", text: "new" },
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
            domEdit,
            { target: { selector: "#a", pierce: true }, action: "set_text", text: "new" },
            extra(),
            runtimeOf(fake, restricted),
        );

        expect(result.isError).toBe(true);
        expect(TEXT(result)).toContain("outside safety.allowedDomains");
    });
});
