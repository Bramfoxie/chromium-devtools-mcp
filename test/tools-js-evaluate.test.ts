import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import {
    elementFunctionDeclaration,
    exceptionText,
    formatExceptionStack,
    isBareEmptyObject,
    isFunctionExpression,
    jsEvaluate,
    newTab,
    runTool,
    shapeRemoteValue,
    STALE_UID_MESSAGE,
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

describe("isFunctionExpression", () => {
    it.each([
        ["function (el) { return el; }", true],
        ["async function (el) { return el; }", true],
        ["(el) => el.textContent", true],
        ["async (el) => el.textContent", true],
        ["el => el.textContent", true],
        ["  function () {}", true],
    ])("classifies %s as a function", (source, expected) => {
        expect(isFunctionExpression(source)).toBe(expected);
    });

    it.each([
        ["return this.textContent;", false],
        ["1 + 2", false],
        ["document.title", false],
        ["(1 + 2) * 3", false],
        ["let x = 1; return x;", false],
    ])("classifies %s as a body", (source, expected) => {
        expect(isFunctionExpression(source)).toBe(expected);
    });
});

describe("elementFunctionDeclaration", () => {
    it("keeps a function expression and wraps a body", () => {
        expect(elementFunctionDeclaration("function (el) { return el; }")).toBe(
            "function (el) { return el; }",
        );
        expect(elementFunctionDeclaration("return this.textContent;")).toBe(
            "function (element) { return this.textContent; }",
        );
    });
});

describe("shapeRemoteValue", () => {
    it("keeps a small structured value and prefers the subtype", () => {
        expect(shapeRemoteValue({ type: "object", subtype: "array", value: [1, 2] }, 50000)).toEqual({
            type       : "array",
            value      : [1, 2],
            truncated  : false,
            totalLength: 5,
        });
    });

    it("truncates a large value with the marker and totals", () => {
        const shaped = shapeRemoteValue({ type: "string", value: "x".repeat(100) }, 10);

        expect(shaped.type).toBe("string");
        expect(shaped.truncated).toBe(true);
        expect(shaped.totalLength).toBe(102);
        expect(shaped.value).toBe(
            '"xxxxxxxxx[truncated: 92 of 102 characters omitted]',
        );
    });

    it("falls back to the unserializable value and the description", () => {
        expect(shapeRemoteValue({ type: "bigint", unserializableValue: "42n" }, 50000)).toEqual({
            type       : "bigint",
            value      : "42n",
            truncated  : false,
            totalLength: 3,
        });
        expect(
            shapeRemoteValue({ type: "function", description: "function () { [native code] }" }, 50000),
        ).toMatchObject({ type: "function", value: "function () { [native code] }" });
        expect(shapeRemoteValue({ type: "undefined" }, 50000)).toMatchObject({
            type : "undefined",
            value: "undefined",
        });
        expect(shapeRemoteValue({ type: "object", subtype: "node", description: "div#main" }, 5)).toMatchObject({
            type     : "node",
            truncated: true,
        });
    });

    it("prefers the description of a remote object reference over its empty value", () => {
        expect(
            shapeRemoteValue({ type: "object", value: {}, description: "h1", objectId: "obj-1" }, 50000),
        ).toMatchObject({ type: "object", value: "h1", truncated: false });
        expect(
            shapeRemoteValue({ type: "object", className: "Window", description: "Window", objectId: "obj-2" }, 50000),
        ).toMatchObject({ type: "object", value: "Window" });
    });
});

describe("isBareEmptyObject", () => {
    it("detects an empty object without any description", () => {
        expect(isBareEmptyObject({ type: "object", value: {} })).toBe(true);
        expect(isBareEmptyObject({ type: "object", value: { a: 1 } })).toBe(false);
        expect(isBareEmptyObject({ type: "object", subtype: "array", value: [] })).toBe(false);
        expect(isBareEmptyObject({ type: "object", subtype: "null", value: null })).toBe(false);
        expect(isBareEmptyObject({ type: "object", value: {}, description: "h1" })).toBe(false);
        expect(isBareEmptyObject({ type: "object", value: {}, objectId: "obj-1" })).toBe(false);
        expect(isBareEmptyObject({ type: "string", value: "" })).toBe(false);
    });
});

describe("exceptionText", () => {
    it("prefers the first line of the thrown value description", () => {
        expect(
            exceptionText({
                text     : "Uncaught",
                exception: { type: "object", subtype: "error", description: "ReferenceError: x is not defined\n    at <anonymous>:1:1" },
            }),
        ).toBe("ReferenceError: x is not defined");
        expect(exceptionText({ text: "Uncaught" })).toBe("Uncaught");
    });
});

describe("formatExceptionStack", () => {
    it("formats call frames and bounds the stack", () => {
        expect(
            formatExceptionStack({
                text      : "boom",
                lineNumber: 3,
                stackTrace: {
                    callFrames: [
                        { functionName: "f", url: "https://x.example/a.js", lineNumber: 0, columnNumber: 4 },
                        { functionName: "", url: "https://x.example/b.js", lineNumber: 9, columnNumber: 0 },
                    ],
                },
            }),
        ).toBe(
            "f (https://x.example/a.js:1:5)\n (https://x.example/b.js:10:1)",
        );
        expect(formatExceptionStack({ text: "boom" })).toBe("");
    });
});

describe("js_evaluate", () => {
    it("evaluates an expression with the expected CDP params", async () => {
        const fake = new FakeAccess();

        fake.respond = () => ({ result: { type: "number", value: 4 } });
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(jsEvaluate, { expression: "2 + 2" }, extra(), runtime);

        expect(result.structuredContent).toEqual({
            ok       : true,
            type     : "number",
            value    : 4,
            truncated: false,
        });
        expect(fake.sent).toHaveLength(1);
        expect(fake.sent[0]).toEqual({
            targetId: "tab1",
            method  : "Runtime.evaluate",
            params  : {
                expression   : "2 + 2",
                returnByValue: true,
                awaitPromise : true,
                userGesture  : false,
                replMode     : false,
            },
            timeoutMs: 10000,
        });
    });

    it("honors awaitPromise, timeoutMs and maxResultChars", async () => {
        const fake = new FakeAccess();

        fake.respond = () => ({ result: { type: "string", value: "abcdefghij" } });
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(
            jsEvaluate,
            { expression: "'abcdefghij'", awaitPromise: false, timeoutMs: 5000, maxResultChars: 5 },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({ ok: true, truncated: true });
        expect(fake.sent[0]?.timeoutMs).toBe(5000);
        expect(fake.sent[0]?.params).toMatchObject({ awaitPromise: false });
    });

    it("returns a page exception as data with a bounded stack", async () => {
        const fake = new FakeAccess();

        fake.respond = () => ({
            result          : { type: "undefined" },
            exceptionDetails: {
                text        : "Uncaught ReferenceError: x is not defined",
                lineNumber  : 0,
                columnNumber: 0,
                stackTrace  : {
                    callFrames: [
                        { functionName: "", url: "https://x.example/", lineNumber: 0, columnNumber: 0 },
                    ],
                },
            },
        });
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(jsEvaluate, { expression: "x" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({
            ok       : false,
            exception: {
                text        : "Uncaught ReferenceError: x is not defined",
                lineNumber  : 0,
                columnNumber: 0,
                stack       : " (https://x.example/:1:1)",
            },
        });
    });

    it("retries an unserializable result as a description and releases it", async () => {
        const fake = new FakeAccess();
        const calls: unknown[] = [];

        fake.respond = (_targetId, method, params) => {
            calls.push(params);

            if (calls.length === 1) {
                throw new RpcError(ErrorCode.cdpError, "Object reference chain is too long");
            }

            return {
                result: { type: "object", className: "Object", description: "Object", objectId: "obj-9" },
            };
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(jsEvaluate, { expression: "window" }, extra(), runtime);

        expect(result.structuredContent).toEqual({
            ok       : true,
            type     : "object",
            value    : "Object",
            truncated: false,
        });
        expect(fake.sent.map((call) => call.method)).toEqual([
            "Runtime.evaluate",
            "Runtime.evaluate",
            "Runtime.releaseObject",
        ]);
        expect(calls[0]).toMatchObject({ returnByValue: true });
        expect(calls[1]).toMatchObject({ returnByValue: false });
        expect(fake.sent[2]?.params).toEqual({ objectId: "obj-9" });
    });

    it("describes a DOM node instead of returning an empty object", async () => {
        const fake = new FakeAccess();
        const calls: unknown[] = [];

        fake.respond = (_targetId, method, params) => {
            calls.push(params);

            if (calls.length === 1) return { result: { type: "object", value: {} } };

            return {
                result: {
                    type       : "object",
                    subtype    : "node",
                    className  : "HTMLHeadingElement",
                    description: "h1",
                    objectId   : "obj-3",
                },
            };
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(jsEvaluate, { expression: "document.querySelector('h1')" }, extra(), runtime);

        expect(result.structuredContent).toEqual({
            ok       : true,
            type     : "node",
            value    : "h1",
            truncated: false,
        });
        expect(fake.sent.map((call) => call.method)).toEqual([
            "Runtime.evaluate",
            "Runtime.evaluate",
            "Runtime.releaseObject",
        ]);
        expect(calls[1]).toMatchObject({ returnByValue: false });
    });

    it("keeps the first result when the description retry has none", async () => {
        const fake = new FakeAccess();
        let calls = 0;

        fake.respond = () => {
            calls += 1;

            return { result: { type: "object", value: {} } };
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(jsEvaluate, { expression: "({})" }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ ok: true, value: {} });
        expect(calls).toBe(2);
    });

    it("reports the original error when the description retry also fails", async () => {
        const fake = new FakeAccess();

        fake.failSend = () => new RpcError(ErrorCode.cdpError, "Cannot find context with specified id");
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(jsEvaluate, { expression: "1" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("Cannot find context with specified id");
        expect(fake.sent.map((call) => call.method)).toEqual(["Runtime.evaluate", "Runtime.evaluate"]);
    });

    it("stops a timed out script and leaves a usable page", async () => {
        const fake = new FakeAccess();

        fake.failSend = (_targetId, method) => {
            if (method === "Runtime.evaluate") {
                return new RpcError(ErrorCode.cdpTimeout, "CDP request timed out.");
            }

            return new RpcError(ErrorCode.internal, `unexpected call ${method}`);
        };

        fake.respond = () => ({});
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(
            jsEvaluate,
            { expression: "while (true) {}", timeoutMs: 1000 },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("did not finish within 1000 ms");
        expect(fake.sent.map((call) => call.method)).toEqual([
            "Runtime.evaluate",
            "Runtime.terminateExecution",
        ]);
    });

    it("runs a function body against an element uid as this and first argument", async () => {
        const fake = new FakeAccess();

        fake.respond = () => ({ result: { type: "string", value: "hi" } });
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        runtime.elements.nextGeneration("tab1");

        const [uid] = runtime.elements.assign("tab1", [{ backendNodeId: 7 }]);

        fake.respond = (_targetId, method) => {
            if (method === "DOM.resolveNode") return { object: { objectId: "obj-7" } };

            return { result: { type: "string", value: "hi" } };
        };

        const result = await runTool(
            jsEvaluate,
            { expression: "return this.textContent;", target: { uid } },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({ ok: true, value: "hi" });
        expect(fake.sent.map((call) => call.method)).toEqual([
            "DOM.resolveNode",
            "Runtime.callFunctionOn",
        ]);
        expect(fake.sent[1]?.params).toEqual({
            functionDeclaration: "function (element) { return this.textContent; }",
            objectId           : "obj-7",
            arguments          : [{ objectId: "obj-7" }],
            returnByValue      : true,
            awaitPromise       : true,
            userGesture        : false,
        });
    });

    it("reports a stale uid without calling the page", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(
            jsEvaluate,
            { expression: "1", target: { uid: "9_9" } },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(STALE_UID_MESSAGE);
        expect(fake.sent).toEqual([]);
    });

    it("names new_tab when no tab is selected", async () => {
        const { runtime } = setup();
        const result = await runTool(jsEvaluate, { expression: "1" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("new_tab");
    });

    it("rejects an overlong expression and timeout", async () => {
        const { runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        const long = await runTool(jsEvaluate, { expression: "x".repeat(100001) }, extra(), runtime);

        expect(long.isError).toBe(true);
        const slow = await runTool(jsEvaluate, { expression: "1", timeoutMs: 60001 }, extra(), runtime);

        expect(slow.isError).toBe(true);
    });
});
