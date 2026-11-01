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
                return { result: { type: "object", subtype: "array", value: rows } };

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
            "DOM.getDocument",
            "DOM.querySelector",
            "Runtime.evaluate",
            "DOM.describeNode",
        ]);
        const expression = (fake.sent[2]?.params as { expression?: string })?.expression ?? "";

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
                                row({
                                    tag       : "input",
                                    attributes: { type: "password", value: "secret" },
                                }),
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
