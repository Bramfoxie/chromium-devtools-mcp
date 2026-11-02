import { execFile } from "node:child_process";
import { runInNewContext } from "node:vm";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import {
    buildPiercedQueryScript,
    buildQueryScript,
    buildRowsFunction,
    clipValue,
    DEFAULT_QUERY_ATTRIBUTES,
    domQuery,
    isPasswordInput,
    QUERY_MAX_TEXT_CANDIDATES,
    newTab,
    roundRect,
    runTool,
    WALK_NODE_BUDGET,
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

function flatAttributes(attributes: Record<string, string>): string[] {
    return Object.entries(attributes).flat();
}

function listObject(objectId: string, length: number) {
    return {
        type       : "object",
        subtype    : "array",
        className  : "Array",
        description: `Array(${length})`,
        objectId,
    };
}

function listProperties(prefix: string, length: number) {
    return {
        result: [
            ...Array.from({ length }, (_, index) => ({
                name        : String(index),
                value       : { type: "object", subtype: "node", className: "HTMLElement", objectId: `${prefix}-${index}` },
                writable    : true,
                configurable: true,
                enumerable  : true,
                isOwn       : true,
            })),
            {
                name        : "length",
                value       : { type: "number", value: length, description: String(length) },
                writable    : true,
                configurable: false,
                enumerable  : false,
                isOwn       : true,
            },
            {
                name        : "__proto__",
                value       : { type: "object", subtype: "array", className: "Array", objectId: `${prefix}-proto` },
                writable    : true,
                configurable: true,
                enumerable  : false,
                isOwn       : false,
            },
        ],
    };
}

function queryFake(rows: Array<ReturnType<typeof row>>, backendIds: number[] = [101, 102]) {
    const fake = new FakeAccess();
    const prefix = "el";

    fake.respond = (_targetId, method, params) => {
        switch (method) {
            case "DOM.getDocument":
                return { root: { nodeId: 1 } };
            case "DOM.querySelector":
                return { nodeId: rows.length === 0 ? 0 : 11 };
            case "DOM.querySelectorAll":
                return { nodeIds: backendIds.map((_, index) => 11 + index) };
            case "Runtime.evaluate":
                return { result: listObject("list-1", rows.length) };
            case "Runtime.callFunctionOn":
                return {
                    result: {
                        type   : "object",
                        subtype: "array",
                        value  : {
                            rows     : rows.map((entry, index) => ({ index, ...entry })),
                            truncated: false,
                        },
                    },
                };
            case "Runtime.getProperties":
                return listProperties(prefix, rows.length);
            case "Runtime.releaseObjectGroup":
                return {};

            case "DOM.describeNode": {
                const objectId = (params as { objectId?: unknown })?.objectId as string;
                const at = Number(objectId.slice(prefix.length + 1));
                const entry = rows[at];

                return {
                    node: {
                        nodeName     : (entry?.tag ?? "a").toUpperCase(),
                        localName    : entry?.tag ?? "a",
                        backendNodeId: backendIds[at] ?? 100 + at,
                        attributes   : flatAttributes(entry?.attributes ?? {}),
                    },
                };
            }

            default:
                throw new Error(`unexpected CDP call ${method}`);
        }
    };

    return fake;
}

interface FakeElement {
    backendNodeId: number;
    text         : string;
}

function makeScriptElement(entry: FakeElement) {
    return {
        localName            : "button",
        id                   : "",
        classList            : [],
        innerText            : entry.text,
        shadowRoot           : undefined,
        backendNodeId        : entry.backendNodeId,
        getAttribute         : () => null,
        getClientRects       : () => [1],
        getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }),
    };
}

class ScriptPage {
    private readonly held = new Map<string, unknown>();
    private counter = 0;

    constructor(readonly elements: FakeElement[]) {}

    evaluate(expression: string) {
        const live = this.elements.map(makeScriptElement);
        const sandbox = {
            document: {
                querySelectorAll: (selector: string) => (selector === "*" ? [] : live),
            },
        };
        const value: unknown = runInNewContext(expression, sandbox);
        const objectId = `list-${(this.counter += 1)}`;

        this.held.set(objectId, value);

        return { result: listObject(objectId, (value as unknown[]).length) };
    }

    owns(objectId: unknown): boolean {
        return typeof objectId === "string" && this.held.has(objectId);
    }

    callFunctionOn(objectId: string, declaration: string) {
        const target = this.held.get(objectId);
        const fn = runInNewContext(`(${declaration})`) as (this: unknown) => unknown;
        const value = JSON.parse(JSON.stringify(fn.call(target))) as unknown;

        return { result: { type: "object", subtype: "array", value } };
    }

    properties(objectId: string) {
        const target = this.held.get(objectId) as unknown[];

        return listProperties(objectId, target.length);
    }

    describe(objectId: string) {
        const [list, at] = objectId.split(/-(?=\d+$)/);
        const target = this.held.get(list ?? "") as Array<{ backendNodeId: number }> | undefined;
        const element = target?.[Number(at)];

        if (element === undefined) throw new Error(`unknown object ${objectId}`);

        return {
            node: {
                nodeName     : "BUTTON",
                localName    : "button",
                backendNodeId: element.backendNodeId,
                attributes   : [],
            },
        };
    }
}

async function runScript(script: string, setup: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        execFile(process.execPath, ["--input-type=module", "-e", `${setup}\n${script}`], (error, stdout) =>
            error ? reject(error) : resolve(stdout),
        );
    });
}

describe("buildQueryScript", () => {
    it("lists matching elements sliced to the count", async () => {
        const setup = `const found = [{ n: 1 }, { n: 2 }, { n: 3 }];
const document = { querySelectorAll: () => found };`;
        const script = `console.log(JSON.stringify(eval(${JSON.stringify(buildQueryScript("a", 2))})));`;

        expect(JSON.parse(await runScript(script, setup))).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it("embeds the selector safely", async () => {
        const setup = `const seen = [];
const document = { querySelectorAll: (s) => { seen.push(s); return []; } };`;
        const script = `eval(${JSON.stringify(buildQueryScript('a[href="x"], b', 3))});
console.log(JSON.stringify(seen));`;

        expect(JSON.parse(await runScript(script, setup))).toEqual(['a[href="x"], b']);
    });
});

describe("pierce node budget", () => {
    it("marks the list truncated once the walk passes the node budget", async () => {
        const setup = `const everything = Array.from({ length: ${WALK_NODE_BUDGET + 1} }, () => ({}));
const document = { querySelectorAll: (s) => s === "*" ? everything : [] };`;
        const script = `console.log(eval(${JSON.stringify(buildPiercedQueryScript("b", 10))}).walkTruncated);`;

        expect((await runScript(script, setup)).trim()).toBe("true");
    });

    it("does not mark a walk inside the budget", async () => {
        const setup = `const document = { querySelectorAll: () => [] };`;
        const script = `console.log(eval(${JSON.stringify(buildPiercedQueryScript("b", 10))}).walkTruncated);`;

        expect((await runScript(script, setup)).trim()).toBe("false");
    });
});

describe("buildRowsFunction", () => {
    it("reads rows from the elements it is called on in a real JavaScript engine", async () => {
        const setup = `const found = [
  { localName: "a", id: "l", classList: ["x"], getAttribute: (n) => n === "href" ? "/p" : null,
    innerText: "Click", getClientRects: () => [1],
    getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }) },
];`;
        const script = `const fn = eval("(" + ${JSON.stringify(buildRowsFunction(["href"]))} + ")");
console.log(JSON.stringify(fn.call(found)));`;

        expect(JSON.parse(await runScript(script, setup))).toEqual({
            rows: [
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
            ],
            truncated: false,
        });
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
            total    : 1,
            returned : 1,
            truncated: false,
        });
        expect(fake.sent.map((call) => call.method)).toEqual([
            "DOM.getDocument",
            "DOM.querySelector",
            "Runtime.evaluate",
            "Runtime.callFunctionOn",
            "Runtime.getProperties",
            "DOM.describeNode",
            "Runtime.releaseObjectGroup",
        ]);
        const declaration =
            (fake.sent[3]?.params as { functionDeclaration?: string })?.functionDeclaration ?? "";

        for (const name of DEFAULT_QUERY_ATTRIBUTES) {
            expect(declaration).toContain(name);
        }

        expect(fake.sent[5]?.params).toEqual({ objectId: "el-0", depth: 0 });
        expect(fake.sent[6]?.params).toEqual({
            objectGroup: (fake.sent[2]?.params as { objectGroup?: string }).objectGroup,
        });

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

    it("marks the result truncated when the text filter covers only the first candidates", async () => {
        const ids = Array.from({ length: QUERY_MAX_TEXT_CANDIDATES + 500 }, (_, i) => 1000 + i);
        const fake = queryFake([row({ text: "Apple" })], ids);
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(
            domQuery,
            { selector: "li", all: true, text: "apple" },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({
            total    : ids.length,
            returned : 1,
            truncated: true,
        });
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

        const uid = (result.structuredContent as { matches: Array<{ uid: string }> }).matches[0]?.uid ?? "";

        expect(uid).not.toBe("");
        expect(runtime.elements.lookup("tab1", uid)).not.toBeUndefined();
    });

    it("keeps the selector total when the text filter matches nothing", async () => {
        const fake = queryFake(
            [row({ text: "Apple" }), row({ text: "Cherry" }), row({ text: "Plum" })],
            [101, 102, 103],
        );
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(
            domQuery,
            { selector: "li", all: true, text: "mango" },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({
            matches  : [],
            total    : 3,
            returned : 0,
            truncated: false,
        });
    });

    it("marks the result truncated when the in-page walk hit its node budget", async () => {
        const fake = queryFake([row()], [101]);
        const inner = fake.respond;

        fake.respond = (targetId, method, params) => {
            const answer = inner?.(targetId, method, params);

            if (method !== "Runtime.callFunctionOn") return answer;

            const value = (answer as { result: { value: { rows: unknown } } }).result.value;

            return { result: { type: "object", value: { rows: value.rows, truncated: true } } };
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(domQuery, { selector: "a" }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ total: 1, returned: 1, truncated: true });
    });

    it("redacts password values and reports them", async () => {
        const fake = queryFake(
            [row({ tag: "input", attributes: { type: "password", value: "secret" } })],
            [55],
        );
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(domQuery, { selector: "input" }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({
            matches: [{ attributes: { type: "password", value: "" }, redacted: true }],
        });
        expect(JSON.stringify(result.structuredContent)).not.toContain("secret");
    });

    it("takes uids from the elements the script returned when the DOM changes between steps", async () => {
        const page = new ScriptPage([
            { backendNodeId: 501, text: "first" },
            { backendNodeId: 502, text: "second" },
        ]);
        const fake = new FakeAccess();

        fake.respond = (_targetId, method, params) => {
            switch (method) {
                case "DOM.getDocument":
                    return { root: { nodeId: 1 } };

                case "DOM.querySelectorAll": {
                    const ids = page.elements.map((_, index) => 11 + index);

                    page.elements.unshift({ backendNodeId: 500, text: "inserted" });

                    return { nodeIds: ids };
                }

                case "Runtime.evaluate":
                    return page.evaluate((params as { expression: string }).expression);
                case "Runtime.callFunctionOn":
                    return page.callFunctionOn(
                        (params as { objectId: string }).objectId,
                        (params as { functionDeclaration: string }).functionDeclaration,
                    );
                case "Runtime.getProperties":
                    return page.properties((params as { objectId: string }).objectId);
                case "DOM.describeNode":
                    return page.describe((params as { objectId: string }).objectId);
                case "Runtime.releaseObjectGroup":
                    return {};
                default:
                    throw new Error(`unexpected CDP call ${method}`);
            }
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(domQuery, { selector: "button", all: true }, extra(), runtime);
        const { matches } = result.structuredContent as {
            matches: Array<{ uid: string; text: string }>;
        };

        expect(matches.map((match) => match.text)).toEqual(["inserted", "first"]);
        expect(matches.map((match) => runtime.elements.lookup("tab1", match.uid))).toEqual([
            { backendNodeId: 500 },
            { backendNodeId: 501 },
        ]);
    });

    it("releases the held objects when reading the rows fails", async () => {
        const fake = queryFake([row()]);
        const inner = fake.respond;

        fake.respond = (targetId, method, params) => {
            if (method === "Runtime.callFunctionOn") throw new Error("boom");

            return inner?.(targetId, method, params);
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(domQuery, { selector: "a" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(fake.sent.map((call) => call.method)).toContain("Runtime.releaseObjectGroup");
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
        expect(result.structuredContent).toEqual({
            matches  : [],
            total    : 0,
            returned : 0,
            truncated: false,
        });
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
        const page = new ScriptPage([
            { backendNodeId: 141, text: "Pay" },
            { backendNodeId: 142, text: "More" },
        ]);

        fake.frames = [
            { frameId: "main", url: "https://a.example/", name: "", isolated: false },
            {
                frameId      : "cross",
                parentFrameId: "main",
                url          : "https://b.example/",
                name         : "pay",
                isolated     : false,
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
                    if ((params as { selector?: unknown })?.selector === "#frame") {
                        return { nodeIds: [10] };
                    }

                    return { nodeIds: [41, 42] };

                case "DOM.describeNode": {
                    const nodeId = (params as { nodeId?: unknown })?.nodeId;
                    const objectId = (params as { objectId?: unknown })?.objectId;

                    if (typeof objectId === "string") return page.describe(objectId);

                    if (nodeId === 10) {
                        return {
                            node: {
                                nodeType       : 1,
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
                                nodeType     : 1,
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
                            nodeType     : 1,
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

                case "Runtime.callFunctionOn": {
                    const call = params as { objectId?: string; functionDeclaration?: string };

                    if (page.owns(call.objectId)) {
                        return page.callFunctionOn(call.objectId as string, call.functionDeclaration ?? "");
                    }

                    return { result: { type: "string", value: "Inner" } };
                }

                case "Runtime.getProperties":
                    return page.properties((params as { objectId: string }).objectId);
                case "Runtime.releaseObjectGroup":
                    return {};

                case "Runtime.evaluate": {
                    const expression = (params as { expression?: unknown })?.expression;

                    if (typeof expression !== "string") {
                        throw new Error("Runtime.evaluate needs a string expression");
                    }

                    return page.evaluate(expression);
                }

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
            "DOM.getDocument",
            "Page.createIsolatedWorld",
            "DOM.getDocument",
            "DOM.querySelector",
            "Runtime.evaluate",
            "Runtime.callFunctionOn",
            "Runtime.getProperties",
            "DOM.describeNode",
            "Runtime.releaseObjectGroup",
        ]);
        expect(fake.sent[1]?.params).toMatchObject({ frameId: "cross" });
        expect(fake.sent[3]?.params).toEqual({ nodeId: 11, selector: "#pay-btn" });
        expect(fake.sent[4]?.params).toMatchObject({ contextId: 7 });
        expect(runtime.elements.lookup("tab1", "0_1")).toEqual({
            backendNodeId  : 141,
            frameId        : "cross",
            frameGeneration: 0,
        });
    });

    it("fails naming the frame when a known frame has no document yet", async () => {
        const fake = piercingFake();
        const inner = fake.respond;

        fake.respond = (targetId, method, params) => {
            if (method === "DOM.getDocument") {
                return { root: { nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: "#document", children: [] } };
            }

            return inner?.(targetId, method, params);
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(domQuery, { selector: "#pay-btn", frame: "cross" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("has no document yet");
        expect(JSON.stringify(result.content)).toContain("cross");
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
            "DOM.getDocument",
            "DOM.querySelectorAll",
            "DOM.describeNode",
            "Page.createIsolatedWorld",
            "DOM.querySelector",
            "Runtime.evaluate",
            "Runtime.callFunctionOn",
            "Runtime.getProperties",
            "DOM.describeNode",
            "Runtime.releaseObjectGroup",
        ]);
        expect(fake.sent[3]?.params).toMatchObject({ frameId: "cross" });
        expect(fake.sent[4]?.params).toEqual({ nodeId: 11, selector: "#same-btn" });
        expect(fake.sent[5]?.params).toMatchObject({ contextId: 7 });
    });

    it("lists the candidates when a frame selector matches several iframes", async () => {
        const fake = piercingFake();
        const inner = fake.respond;

        fake.respond = (targetId, method, params) => {
            if (method === "DOM.querySelectorAll" && (params as { selector?: unknown })?.selector === "iframe") {
                return { nodeIds: [10, 12] };
            }

            if (method === "DOM.describeNode" && (params as { nodeId?: unknown })?.nodeId === 12) {
                return {
                    node: {
                        nodeType       : 1,
                        nodeName       : "IFRAME",
                        localName      : "iframe",
                        backendNodeId  : 22,
                        attributes     : ["id", "second", "name", "ads", "src", "https://c.example/"],
                        frameId        : "ads-frame",
                        contentDocument: { nodeId: 13, documentURL: "https://c.example/ad" },
                    },
                };
            }

            return inner?.(targetId, method, params);
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(domQuery, { selector: "a", frame: "iframe" }, extra(), runtime);
        const text = JSON.stringify(result.content);

        expect(result.isError).toBe(true);
        expect(text).toContain("matches 2 iframes");
        expect(text).toContain("0: <iframe>");
        expect(text).toContain("frame=cross");
        expect(text).toContain("1: <iframe> id=\\\"second\\\" name=\\\"ads\\\"");
        expect(text).toContain("https://c.example/ad");
        expect(text).toContain("frame id from dom_snapshot");
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
            "DOM.getDocument",
            "DOM.enable",
            "DOM.getDocument",
            "DOM.performSearch",
            "DOM.getSearchResults",
            "DOM.describeNode",
            "DOM.describeNode",
            "DOM.discardSearchResults",
            "Runtime.evaluate",
            "Runtime.callFunctionOn",
            "Runtime.getProperties",
            "DOM.describeNode",
            "DOM.describeNode",
            "Runtime.releaseObjectGroup",
        ]);
        const expression = (fake.sent[8]?.params as { expression?: string })?.expression ?? "";

        expect(expression).toContain("shadowRoot");
        expect(result.structuredContent).toMatchObject({ total: 2, returned: 2 });
    });

    it("reports the true pierce total and marks a capped result truncated", async () => {
        const fake = piercingFake();
        const inner = fake.respond;

        fake.respond = (targetId, method, params) => {
            if (method === "DOM.performSearch") return { searchId: "s1", resultCount: 350 };

            if (method === "DOM.getSearchResults") {
                return { nodeIds: Array.from({ length: 200 }, (_, at) => 41 + at) };
            }

            return inner?.(targetId, method, params);
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(
            domQuery,
            { selector: "button", all: true, pierce: true },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({
            total    : 350,
            truncated: true,
        });
    });

    it("excludes unusable search hits from the pierce total", async () => {
        const fake = piercingFake();
        const inner = fake.respond;

        fake.respond = (targetId, method, params) => {
            if (method === "DOM.performSearch") return { searchId: "s1", resultCount: 2 };
            if (method === "DOM.getSearchResults") return { nodeIds: [41, 42] };

            if (
                method === "DOM.describeNode" &&
                (params as { nodeId?: unknown })?.nodeId === 42
            ) {
                return { node: { nodeType: 3, nodeName: "#text", backendNodeId: 9 } };
            }

            return inner?.(targetId, method, params);
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(
            domQuery,
            { selector: "button", all: true, pierce: true },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({
            total    : 1,
            returned : 1,
            truncated: false,
        });
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

    it("keeps pierce matches inside the selected frame and returns attributes", async () => {
        const fake = piercingFake();
        const inner = fake.respond;

        fake.respond = (targetId, method, params) => {
            if (method === "DOM.getDocument" && (params as { pierce?: unknown })?.pierce === true) {
                return {
                    root: {
                        nodeId  : 1,
                        nodeName: "#document",
                        children: [
                            { nodeId: 99, nodeName: "BUTTON" },
                            {
                                nodeId         : 10,
                                nodeName       : "IFRAME",
                                frameId        : "cross",
                                contentDocument: {
                                    nodeId  : 11,
                                    nodeName: "#document",
                                    children: [
                                        { nodeId: 41, nodeName: "BUTTON" },
                                        { nodeId: 42, nodeName: "BUTTON" },
                                    ],
                                },
                            },
                        ],
                    },
                };
            }

            if (method === "DOM.performSearch") return { searchId: "s1", resultCount: 3 };
            if (method === "DOM.getSearchResults") return { nodeIds: [99, 41, 42] };

            return inner?.(targetId, method, params);
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(
            domQuery,
            { selector: "button", all: true, pierce: true, frame: "cross" },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ total: 2, returned: 2 });
        expect(runtime.elements.lookup("tab1", "0_1")).toMatchObject({ frameId: "cross" });
        expect(runtime.elements.lookup("tab1", "0_3")).toBeUndefined();
    });

    it("returns the requested attributes for a chained selector", async () => {
        const fake = piercingFake();
        const inner = fake.respond;

        fake.respond = (targetId, method, params) => {
            if (method === "DOM.describeNode" && (params as { nodeId?: unknown })?.nodeId === 15) {
                return {
                    node: {
                        nodeName     : "BUTTON",
                        localName    : "button",
                        backendNodeId: 115,
                        attributes   : ["id", "inner", "title", "Save", "name", "n"],
                    },
                };
            }

            return inner?.(targetId, method, params);
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(
            domQuery,
            { selector: "my-app >>> #inner", attributes: ["title"] },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({
            matches: [{ id: "inner", attributes: { title: "Save" } }],
        });
        expect(JSON.stringify(result.structuredContent)).not.toContain('"name"');
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
        const setup = `const inner = { localName: "button" };
const shadow = { querySelectorAll: (s) => s === "*" ? [] : (s === "button" ? [inner] : []) };
const host = { shadowRoot: shadow, localName: "div" };
const document = { querySelectorAll: (s) => s === "*" ? [host] : [] };`;
        const script = `console.log(JSON.stringify(eval(${JSON.stringify(buildPiercedQueryScript("button", 10))})));`;

        expect(JSON.parse(await runScript(script, setup))).toEqual([{ localName: "button" }]);
    });
});
