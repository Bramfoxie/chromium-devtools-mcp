import { execFile } from "node:child_process";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import {
    buildQueryScript,
    clipValue,
    DEFAULT_QUERY_ATTRIBUTES,
    domQuery,
    isPasswordInput,
    newTab,
    roundRect,
    runTool,
    ToolRuntime,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

function setup(access?: FakeAccess) {
    const fake = access ?? new FakeAccess();
    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

    return { fake, runtime };
}

function row(overrides: Record<string, unknown> = {}) {
    return {
        tag       : "a",
        id        : "",
        classes   : [],
        attributes: {},
        text      : "",
        visible   : true,
        rect      : { x: 1.4, y: 2.5, width: 10.2, height: 20.7 },
        ...overrides,
    };
}

function queryFake(rows: Array<ReturnType<typeof row>>, backendIds: number[] = [101, 102]) {
    const fake = new FakeAccess();

    fake.respond = (_targetId, method, params) => {
        switch (method) {
            case "DOM.getDocument":
                return { root: { nodeId: 1 } };
            case "DOM.querySelector":
                return { nodeId: rows.length === 0 ? 0 : 11 };
            case "DOM.querySelectorAll":
                return { nodeIds: backendIds.map((_, index) => 11 + index) };
            case "Runtime.evaluate":
                return {
                    result: {
                        type   : "object",
                        subtype: "array",
                        value  : rows.map((entry, index) => ({ index, ...entry })),
                    },
                };

            case "DOM.describeNode": {
                const nodeId = (params as { nodeId?: unknown })?.nodeId as number;
                const backendNodeId = backendIds[nodeId - 11] ?? 100 + nodeId;

                return {
                    node: {
                        nodeName  : "A",
                        localName : "a",
                        backendNodeId,
                        attributes: [],
                    },
                };
            }

            default:
                throw new Error(`unexpected CDP call ${method}`);
        }
    };

    return fake;
}

describe("buildQueryScript", () => {
    it("reads rows in a real JavaScript engine", async () => {
        const script = `const found = [
  { localName: "a", id: "l", classList: ["x"], getAttribute: (n) => n === "href" ? "/p" : null,
    innerText: "Click", getClientRects: () => [1],
    getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }) },
];
const document = { querySelectorAll: () => found };
console.log(JSON.stringify(eval(${JSON.stringify(buildQueryScript("a", ["href"], 10))})));`;
        const output = await new Promise<string>((resolve, reject) => {
            execFile(process.execPath, ["--input-type=module", "-e", script], (error, stdout) =>
                error ? reject(error) : resolve(stdout),
            );
        });

        expect(JSON.parse(output)).toEqual([
            {
                index     : 0,
                tag       : "a",
                id        : "l",
                classes   : ["x"],
                attributes: { href: "/p" },
                text      : "Click",
                visible   : true,
                rect      : { x: 1, y: 2, width: 3, height: 4 },
            },
        ]);
    });

    it("embeds the selector safely and slices to the count", async () => {
        const script = `const seen = [];
const document = { querySelectorAll: (s) => { seen.push(s); return []; } };
eval(${JSON.stringify(buildQueryScript('a[href="x"], b', ["id"], 3))});
console.log(JSON.stringify(seen));`;
        const output = await new Promise<string>((resolve, reject) => {
            execFile(process.execPath, ["--input-type=module", "-e", script], (error, stdout) =>
                error ? reject(error) : resolve(stdout),
            );
        });

        expect(JSON.parse(output)).toEqual(['a[href="x"], b']);
    });
});

describe("clipValue", () => {
    it("clips long values to 200 characters", () => {
        expect(clipValue("short")).toBe("short");
        expect(clipValue("x".repeat(200))).toHaveLength(200);
        expect(clipValue("x".repeat(201))).toHaveLength(200);
    });
});

describe("roundRect", () => {
    it("rounds every edge", () => {
        expect(roundRect({ x: 1.4, y: 2.5, width: 10.2, height: 20.7 })).toEqual({
            x     : 1,
            y     : 3,
            width : 10,
            height: 21,
        });
    });
});

describe("isPasswordInput", () => {
    it("detects password inputs case insensitively", () => {
        expect(isPasswordInput(["type", "password", "value", "secret"])).toBe(true);
        expect(isPasswordInput(["type", "Password"])).toBe(true);
        expect(isPasswordInput(["type", "text"])).toBe(false);
        expect(isPasswordInput([])).toBe(false);
    });
});

describe("dom_query", () => {
    it("queries a single element with the default attributes", async () => {
        const fake = queryFake([
            row({ tag: "a", id: "l", classes: ["x"], attributes: { href: "/p" }, text: "Click" }),
        ]);
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(domQuery, { selector: "a" }, extra(), runtime);

        expect(result.structuredContent).toEqual({
            matches: [
                {
                    uid       : "0_1",
                    tag       : "a",
                    id        : "l",
                    classes   : ["x"],
                    attributes: { href: "/p" },
                    text      : "Click",
                    visible   : true,
                    box       : { x: 1, y: 3, width: 10, height: 21 },
                },
            ],
            total   : 1,
            returned: 1,
        });
        expect(fake.sent.map((call) => call.method)).toEqual([
            "Page.enable",
            "DOM.getDocument",
            "DOM.querySelector",
            "Runtime.evaluate",
            "DOM.describeNode",
        ]);
        const expression = (fake.sent[3]?.params as { expression?: string })?.expression ?? "";

        for (const name of DEFAULT_QUERY_ATTRIBUTES) {
            expect(expression).toContain(name);
        }

        expect(runtime.elements.lookup("tab1", "0_1")).toEqual({ backendNodeId: 101 });
    });

    it("returns all matches up to the limit with totals", async () => {
        const fake = queryFake([row({ text: "one" }), row({ text: "two" })], [101, 102, 103]);
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(domQuery, { selector: "li", all: true, limit: 1 }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ total: 3, returned: 1 });
        expect((result.structuredContent as { matches: unknown[] }).matches).toHaveLength(1);
    });

    it("filters by text case insensitively and omits boxes on request", async () => {
        const fake = queryFake([row({ text: "Apple pie" }), row({ text: "Cherry tart" })], [101, 102, 103]);
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(
            domQuery,
            { selector: "li", all: true, text: "CHERRY", includeBox: false },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({ total: 3, returned: 1 });
        expect(result.structuredContent).toMatchObject({ matches: [{ text: "Cherry tart", box: null }] });

        // The uid must resolve to the Cherry row (index 1), not to the first match.
        const uid = (result.structuredContent as { matches: Array<{ uid: string }> }).matches[0]?.uid ?? "";

        expect(uid).not.toBe("");
        expect(runtime.elements.lookup("tab1", uid)).not.toBeUndefined();
    });

    it("redacts password values and reports them", async () => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method, params) => {
            switch (method) {
                case "DOM.getDocument":
                    return { root: { nodeId: 1 } };
                case "DOM.querySelector":
                    return { nodeId: 11 };
                case "Runtime.evaluate":
                    return {
                        result: {
                            type : "object",
                            value: [
                                {
                                    ...row({
                                        tag       : "input",
                                        attributes: { type: "password", value: "secret" },
                                    }),
                                    index: 0,
                                },
                            ],
                        },
                    };
                case "DOM.describeNode":
                    expect(params).toMatchObject({ nodeId: 11 });

                    return {
                        node: {
                            nodeName     : "INPUT",
                            localName    : "input",
                            backendNodeId: 55,
                            attributes   : ["type", "password", "value", "secret"],
                        },
                    };
                default:
                    throw new Error(`unexpected CDP call ${method}`);
            }
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(domQuery, { selector: "input" }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({
            matches: [{ attributes: { type: "password", value: "" }, redacted: true }],
        });
        expect(JSON.stringify(result.structuredContent)).not.toContain("secret");
    });

    it("quotes the DOM message of an invalid selector", async () => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) => {
            if (method === "DOM.getDocument") return { root: { nodeId: 1 } };

            throw new RpcError(ErrorCode.cdpError, "'??' is not a valid selector.");
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(domQuery, { selector: "??", all: true }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("'??' is not a valid selector.");
    });

    it("returns an empty result when nothing matches", async () => {
        const fake = queryFake([]);
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(domQuery, { selector: ".missing" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({ matches: [], total: 0, returned: 0 });
    });

    it("names new_tab when no tab is selected", async () => {
        const { runtime } = setup();
        const result = await runTool(domQuery, { selector: "a" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("new_tab");
    });
});

describe("dom_query piercing", () => {
    function piercingFake() {
        const fake = new FakeAccess();

        fake.frames = [
            { frameId: "main", url: "https://a.example/", name: "", isolated: false },
            {
                frameId      : "cross",
                parentFrameId: "main",
                url          : "https://b.example/",
                name         : "pay",
                isolated     : true,
            },
        ];

        fake.respond = (_targetId, method, params) => {
            switch (method) {
                case "DOM.getDocument": {
                    const pierce = (params as { pierce?: unknown })?.pierce;

                    if (pierce === true) {
                        return {
                            root: {
                                nodeId  : 1,
                                nodeName: "#document",
                                children: [
                                    {
                                        nodeId         : 10,
                                        nodeName       : "IFRAME",
                                        frameId        : "cross",
                                        contentDocument: { nodeId: 11, nodeName: "#document" },
                                    },
                                ],
                            },
                        };
                    }

                    return { root: { nodeId: 1 } };
                }

                case "DOM.querySelector": {
                    const selector = (params as { selector?: unknown })?.selector;

                    if (selector === "#frame") return { nodeId: 10 };
                    if (selector === "my-app") return { nodeId: 13 };
                    if (selector === "#inner") return { nodeId: 15 };

                    return { nodeId: 41 };
                }

                case "DOM.querySelectorAll":
                    return { nodeIds: [41, 42] };

                case "DOM.describeNode": {
                    const nodeId = (params as { nodeId?: unknown })?.nodeId;

                    if (nodeId === 10) {
                        return {
                            node: {
                                nodeName       : "IFRAME",
                                localName      : "iframe",
                                backendNodeId  : 20,
                                frameId        : "cross",
                                contentDocument: { nodeId: 11 },
                            },
                        };
                    }

                    if (nodeId === 13) {
                        return {
                            node: {
                                nodeName     : "MY-APP",
                                localName    : "my-app",
                                backendNodeId: 5,
                                attributes   : [],
                                shadowRoots  : [{ nodeId: 14 }],
                            },
                        };
                    }

                    return {
                        node: {
                            nodeName     : "BUTTON",
                            localName    : "button",
                            backendNodeId: 100 + (nodeId as number),
                            attributes   : ["id", "inner"],
                        },
                    };
                }

                case "DOM.resolveNode":
                    return { object: { objectId: "obj-1" } };
                case "DOM.getBoxModel":
                    return {
                        model: {
                            content: [10, 20, 30, 20, 30, 40, 10, 40],
                            padding: [10, 20, 30, 20, 30, 40, 10, 40],
                            border : [10, 20, 30, 20, 30, 40, 10, 40],
                            margin : [10, 20, 30, 20, 30, 40, 10, 40],
                        },
                    };
                case "DOM.enable":
                    return {};
                case "DOM.performSearch":
                    return { searchId: "s1", resultCount: 2 };
                case "DOM.getSearchResults":
                    return { nodeIds: [41, 42] };
                case "DOM.discardSearchResults":
                    return {};
                case "Page.createIsolatedWorld":
                    return { executionContextId: 7 };
                case "Runtime.callFunctionOn":
                    return { result: { type: "string", value: "Inner" } };
                case "Runtime.evaluate":
                    return {
                        result: {
                            type   : "object",
                            subtype: "array",
                            value  : [
                                { ...row({ tag: "button", text: "Pay" }), index: 0 },
                                { ...row({ tag: "button", text: "More" }), index: 1 },
                            ],
                        },
                    };
                default:
                    throw new Error(`unexpected CDP call ${method}`);
            }
        };

        return fake;
    }

    it("queries inside a frame selected by id through an isolated world", async () => {
        const fake = piercingFake();
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(domQuery, { selector: "#pay-btn", frame: "cross" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(fake.sent.map((call) => call.method)).toEqual([
            "Page.enable",
            "DOM.getDocument",
            "Page.createIsolatedWorld",
            "DOM.getDocument",
            "DOM.querySelector",
            "Runtime.evaluate",
            "DOM.describeNode",
        ]);
        expect(fake.sent[2]?.params).toMatchObject({ frameId: "cross" });
        expect(fake.sent[4]?.params).toEqual({ nodeId: 11, selector: "#pay-btn" });
        expect(fake.sent[5]?.params).toMatchObject({ contextId: 7 });
        expect(runtime.elements.lookup("tab1", "0_1")).toEqual({
            backendNodeId  : 141,
            frameId        : "cross",
            frameGeneration: 0,
        });
    });

    it("queries inside a frame selected by an iframe selector", async () => {
        const fake = piercingFake();
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(
            domQuery,
            { selector: "#same-btn", frame: "#frame" },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(fake.sent.map((call) => call.method)).toEqual([
            "Page.enable",
            "DOM.getDocument",
            "DOM.querySelector",
            "DOM.describeNode",
            "Page.createIsolatedWorld",
            "DOM.querySelector",
            "Runtime.evaluate",
            "DOM.describeNode",
        ]);
        expect(fake.sent[4]?.params).toMatchObject({ frameId: "cross" });
        expect(fake.sent[5]?.params).toEqual({ nodeId: 11, selector: "#same-btn" });
        expect(fake.sent[6]?.params).toMatchObject({ contextId: 7 });
    });

    it("matches through shadow roots with pierce", async () => {
        const fake = piercingFake();
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(
            domQuery,
            { selector: "button", all: true, pierce: true },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(fake.sent.map((call) => call.method)).toEqual([
            "Page.enable",
            "DOM.getDocument",
            "DOM.enable",
            "DOM.getDocument",
            "DOM.performSearch",
            "DOM.getSearchResults",
            "DOM.discardSearchResults",
            "Runtime.evaluate",
            "DOM.describeNode",
            "DOM.describeNode",
        ]);
        const expression = (fake.sent[7]?.params as { expression?: string })?.expression ?? "";

        expect(expression).toContain("shadowRoot");
        expect(result.structuredContent).toMatchObject({ total: 2, returned: 2 });
    });

    it("resolves >>> chains element by element without page script order", async () => {
        const fake = piercingFake();
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(
            domQuery,
            { selector: "my-app >>> #inner" },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            matches: [
                { tag: "button", id: "inner", text: "Inner", visible: true },
            ],
            total   : 1,
            returned: 1,
        });
        expect(fake.sent.map((call) => call.method)).not.toContain("Runtime.evaluate");
    });

    it("rejects pierce together with a chain", async () => {
        const { runtime } = setup(piercingFake());

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(
            domQuery,
            { selector: "a >>> b", pierce: true },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("not both");
    });
});

describe("buildPiercedQueryScript", () => {
    it("walks shadow roots in a real JavaScript engine", async () => {
        const { buildPiercedQueryScript } = await import("../src/tools/index.js");
        const script = `const inner = {
  localName: "button", id: "in", classList: [], getAttribute: () => null,
  innerText: "In", getClientRects: () => [1],
  getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }) };
const shadow = { querySelectorAll: (s) => s === "*" ? [] : (s === "button" ? [inner] : []) };
const host = { shadowRoot: shadow, localName: "div" };
const document = { querySelectorAll: (s) => s === "*" ? [host] : [] };
console.log(JSON.stringify(eval(${JSON.stringify(buildPiercedQueryScript("button", ["id"], 10))})));`;
        const output = await new Promise<string>((resolve, reject) => {
            execFile(process.execPath, ["--input-type=module", "-e", script], (error, stdout) =>
                error ? reject(error) : resolve(stdout),
            );
        });

        expect(JSON.parse(output)).toEqual([
            {
                tag       : "button",
                id        : "in",
                classes   : [],
                attributes: {},
                text      : "In",
                visible   : true,
                rect      : { x: 1, y: 2, width: 3, height: 4 },
            },
        ]);
    });
});
