import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import { useFakeClock } from "./helpers/fake-clock.js";
import {
    cancelWaitScript,
    checkConditions,
    expressionScript,
    pageWait,
    runTool,
    selectorScript,
    textScript,
    ToolRuntime,
    WALK_NODE_BUDGET,
    waitOutcomeOf,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function extra(signal?: AbortSignal): Extra {
    return { signal: signal ?? new AbortController().signal } as Extra;
}

function setup() {
    const fake = new FakeAccess({
        tabs: [
            { targetId: "tab1", url: "https://a.example/", title: "a", owned: true, created: true },
        ],
    });
    const sleeps: number[] = [];
    let now = 1_700_000_000_000;
    const runtime = new ToolRuntime({
        access: fake.asAccess(),
        config: managedConfig,
        clock : {
            now  : () => now,
            sleep: async (ms) => {
                sleeps.push(ms);
                now += ms;
            },
        },
    });

    runtime.capture.attach();
    runtime.tabs.refresh(
        [{ targetId: "tab1", url: "https://a.example/", title: "a", owned: true, created: true }],
        "tab1",
    );

    return { fake, runtime, sleeps, advance: (ms: number) => void (now += ms) };
}

function textOf(result: Awaited<ReturnType<typeof runTool>>): string {
    return JSON.stringify(result.content);
}

describe("checkConditions", () => {
    it("accepts each single condition", () => {
        expect(checkConditions({ selector: ".x" })).toBe("selector");
        expect(checkConditions({ text: "hi" })).toBe("text");
        expect(checkConditions({ selector: ".x", text: "hi" })).toBe("text");
        expect(checkConditions({ url: "a" })).toBe("url");
        expect(checkConditions({ urlRegex: "a+" })).toBe("urlRegex");
        expect(checkConditions({ loadState: "load" })).toBe("loadState");
        expect(checkConditions({ expression: "true" })).toBe("expression");
        expect(checkConditions({ ms: 10 })).toBe("ms");
    });

    it("rejects none and several", () => {
        expect(() => checkConditions({})).toThrow("exactly one wait condition");
        expect(() => checkConditions({ url: "a", ms: 5 })).toThrow("not several");
    });
});

describe("wait scripts", () => {
    function pageWorld() {
        const live = new Set<unknown>();
        const world = {
            document        : { querySelectorAll: () => [], body: { innerText: "" } },
            getComputedStyle: () => ({ visibility: "visible" }),
            Date,
            Map,
            Promise,
            setTimeout      : (fn: () => void, ms: number) => {
                const handle = setTimeout(() => {
                    live.delete(handle);
                    fn();
                }, ms);

                live.add(handle);

                return handle;
            },
            clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
                live.delete(handle);
                clearTimeout(handle);
            },
        };

        return { live, context: vm.createContext(world) };
    }

    it.each([
        ["selector", (t: string) => selectorScript(".x", "visible", 50, 60_000, false, t)],
        ["text", (t: string) => textScript("zzz", undefined, 50, 60_000, t)],
        ["expression", (t: string) => expressionScript("false", 50, 60_000, t)],
    ])("leaves no timer behind after a %s wait is cancelled", async (_name, build) => {
        const clock = useFakeClock();

        try {
            const { live, context } = pageWorld();
            const running = vm.runInContext(build("tok"), context) as Promise<{ met: boolean }>;

            await clock.advance(120);
            expect(live.size).toBe(1);
            vm.runInContext(cancelWaitScript("tok"), context);

            await expect(running).resolves.toMatchObject({ met: false });
            expect(live.size).toBe(0);
            expect(vm.runInContext("globalThis.__chromiumDevtoolsMcpWaits.size", context)).toBe(0);
        } finally {
            clock.restore();
        }
    });

    it("stops a pierce selector wait at the node budget and reports it", async () => {
        const { context } = pageWorld();
        const everything = Array.from({ length: WALK_NODE_BUDGET + 1 }, () => ({}));

        (context as unknown as { document: { querySelectorAll: unknown } }).document
            .querySelectorAll = (selector: string) => (selector === "*" ? everything : []);

        const outcome = await (vm.runInContext(
            selectorScript(".x", "attached", 50, 200, true, "budget"),
            context,
        ) as Promise<{ met: boolean; detail: { capped: boolean } }>);

        expect(outcome.met).toBe(false);
        expect(outcome.detail.capped).toBe(true);
    });

    it("builds selector waits that embed the selector and the state", () => {
        const script = selectorScript(".x", "attached", 100, 1000);

        expect(script).toContain(JSON.stringify(".x"));
        expect(script).toContain(JSON.stringify("attached"));
        expect(script).toContain("querySelectorAll");
        expect(script).toContain("getBoundingClientRect");
    });

    it("builds text waits with an optional scope", () => {
        expect(textScript("hi", undefined, 100, 1000)).toContain("document.body");
        expect(textScript("hi", ".main", 100, 1000)).toContain(JSON.stringify(".main"));
        expect(textScript("hi", ".main", 100, 1000)).toContain("innerText");
    });

    it("wraps expressions so statements become values and awaits promises", () => {
        const script = expressionScript("window.ready", 100, 1000);

        expect(script).toContain("check = () => (window.ready)");
        expect(script).toContain("await check()");
    });

    it("parses the canned in-page result", () => {
        expect(
            waitOutcomeOf({ result: { value: { met: true, detail: { matched: 2 } } } }),
        ).toEqual({ met: true, detail: { matched: 2 } });
        expect(waitOutcomeOf({ result: {} })).toBeUndefined();
        expect(waitOutcomeOf({ nope: 1 })).toBeUndefined();
    });
});

describe("page_wait", () => {
    it("waits for a selector with one in-page evaluate", async () => {
        const { fake, runtime } = setup();

        fake.respond = () => ({
            result: { value: { met: true, detail: { matched: 1, visible: 1 } } },
        });

        const result = await runTool(
            pageWait,
            { selector: ".ready", state: "visible", timeoutMs: 1000 },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            tab      : "tab1",
            met      : true,
            condition: 'selector ".ready" visible',
            detail   : { matched: 1, visible: 1 },
        });
        expect(fake.sent).toHaveLength(2);
        expect(fake.sent[1]).toMatchObject({
            targetId: "tab1",
            method  : "Runtime.evaluate",
            params  : { awaitPromise: true, returnByValue: true },
        });
        expect(String(fake.sent[1]?.params?.expression)).toContain(".ready");
    });

    it("names a syntax error or invalid selector thrown in the page", async () => {
        const { fake, runtime } = setup();

        fake.respond = () => ({
            result          : { type: "object", subtype: "error", className: "SyntaxError" },
            exceptionDetails: {
                exceptionId: 1,
                text       : "Uncaught",
                exception  : {
                    type       : "object",
                    description: "SyntaxError: Failed to execute 'querySelectorAll' on 'Document': '[' is not a valid selector.\n    at <anonymous>:3:1",
                },
            },
        });

        const result = await runTool(pageWait, { selector: "[" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("is not a valid selector");
        expect(textOf(result)).not.toContain("unexpected response");
        expect(textOf(result)).not.toContain("..");
    });

    it("returns met false with detail on timeout instead of an error", async () => {
        const { fake, runtime } = setup();

        fake.respond = () => ({
            result: { value: { met: false, detail: { matched: 0, visible: 0 } } },
        });

        const result = await runTool(pageWait, { selector: ".missing" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            met   : false,
            detail: { matched: 0, visible: 0 },
        });
    });

    it("waits for scoped text and expressions in the page", async () => {
        const { fake, runtime } = setup();

        fake.respond = () => ({
            result: { value: { met: true, detail: { found: true, length: 42 } } },
        });

        const texted = await runTool(
            pageWait,
            { text: "done", selector: ".main" },
            extra(),
            runtime,
        );

        expect(texted.structuredContent).toMatchObject({ met: true });
        expect(String(fake.sent[1]?.params?.expression)).toContain(JSON.stringify(".main"));

        const expressed = await runTool(
            pageWait,
            { expression: "window.done === true" },
            extra(),
            runtime,
        );

        expect(expressed.structuredContent).toMatchObject({ met: true });
        expect(String(fake.sent[2]?.params?.expression)).toContain("window.done === true");
    });

    it("matches a URL substring and a regex", async () => {
        const { fake, runtime } = setup();
        const urls = ["https://a.example/old", "https://a.example/new"];

        fake.respond = () => ({ result: { value: urls.shift() ?? urls.at(-1) } });

        const substring = await runTool(pageWait, { url: "/new" }, extra(), runtime);

        expect(substring.structuredContent).toMatchObject({
            met   : true,
            detail: { url: "https://a.example/new" },
        });

        urls.push("https://a.example/new");
        fake.respond = () => ({ result: { value: "https://a.example/new?x=1" } });

        const regexed = await runTool(pageWait, { urlRegex: "new\\?x=\\d" }, extra(), runtime);

        expect(regexed.structuredContent).toMatchObject({ met: true });
    });

    it("times out a URL wait with the last URL", async () => {
        const { fake, runtime } = setup();

        fake.respond = () => ({ result: { value: "https://a.example/old" } });

        const result = await runTool(
            pageWait,
            { url: "/new", timeoutMs: 150, pollMs: 100 },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            met   : false,
            detail: { url: "https://a.example/old" },
        });
    });

    it("rejects a bad urlRegex with the step 15 message", async () => {
        const { runtime } = setup();
        const result = await runTool(pageWait, { urlRegex: "([" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("not a valid regular expression");
    });

    it("waits for document load states", async () => {
        const { fake, runtime } = setup();
        const states = ["loading", "interactive", "complete"];

        fake.respond = () => ({ result: { value: states.shift() ?? "complete" } });

        const dom = await runTool(pageWait, { loadState: "domcontentloaded" }, extra(), runtime);

        expect(dom.structuredContent).toMatchObject({ met: true, detail: { readyState: "interactive" } });

        const loaded = await runTool(pageWait, { loadState: "load" }, extra(), runtime);

        expect(loaded.structuredContent).toMatchObject({ met: true, detail: { readyState: "complete" } });
    });

    it("requires 500 ms of observed quiet even with an empty network buffer", async () => {
        const { fake, runtime, sleeps } = setup();

        await runtime.capture.ensureNetwork("tab1");
        fake.sent.length = 0;

        const result = await runTool(pageWait, { loadState: "networkidle" }, extra(), runtime);
        const detail = (result.structuredContent as { detail: { idleMs: number } }).detail;

        expect(result.structuredContent).toMatchObject({ met: true });
        expect(detail.idleMs).toBeGreaterThanOrEqual(500);
        expect(detail.idleMs).toBeLessThan(Number.MAX_SAFE_INTEGER);
        expect(sleeps.length).toBeGreaterThan(0);
        expect(fake.sent.map((call) => call.method)).not.toContain("Network.disable");
    });

    it("waits until in-flight requests finish for networkidle", async () => {
        const { fake, runtime } = setup();
        let now = 1_700_000_000_000;

        Object.assign(runtime.clock, {
            now  : () => now,
            sleep: async (ms: number) => void (now += ms),
        });
        await runtime.capture.ensureNetwork("tab1");
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Network.requestWillBeSent",
            params  : {
                requestId: "r1",
                request  : { url: "https://a.example/slow", method: "GET" },
                timestamp: 100,
                type     : "XHR",
            },
        });
        expect(runtime.capture.idleNetworkMs("tab1")).toBe(0);

        now += 100;
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Network.loadingFinished",
            params  : { requestId: "r1", timestamp: 100.2, encodedDataLength: 10 },
        });
        expect(runtime.capture.idleNetworkMs("tab1")).toBe(0);
        now += 600;
        expect(runtime.capture.idleNetworkMs("tab1")).toBe(600);

        const result = await runTool(pageWait, { loadState: "networkidle" }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ met: true });
        expect(
            (result.structuredContent as { detail: { idleMs: number } }).detail.idleMs,
        ).toBeGreaterThanOrEqual(500);
    });

    it("ignores replayed records that predate the wait", async () => {
        const { fake, runtime } = setup();

        await runtime.capture.ensureNetwork("tab1");
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Network.responseReceived",
            params  : {
                requestId: "replayed",
                timestamp: 100,
                type     : "Document",
                response : {
                    url       : "https://a.example/",
                    status    : 200,
                    statusText: "OK",
                },
            },
        });

        const result = await runTool(pageWait, { loadState: "networkidle" }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ met: true });
    });

    it("sleeps the full requested time without touching the page", async () => {
        const { fake, runtime, sleeps } = setup();
        const result = await runTool(pageWait, { ms: 5000, timeoutMs: 1000 }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({
            met   : true,
            detail: { sleptMs: 5000 },
        });
        expect(sleeps).toEqual([5000]);
        expect(fake.sent).toEqual([]);
    });

    it("stops a script wait on cancellation and terminates execution", async () => {
        const { fake, runtime } = setup();
        const controller = new AbortController();

        fake.respond = () => {
            throw new RpcError(ErrorCode.cdpTimeout, "Timed out.");
        };

        const pending = runTool(pageWait, { selector: ".slow" }, extra(controller.signal), runtime);

        controller.abort();
        const result = await pending;

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("cancelled");
    });

    it("cancels the page wait when the script call times out", async () => {
        const { fake, runtime } = setup();

        fake.respond = (method) => {
            if (method === "Runtime.evaluate" && fake.sent.length === 1) {
                throw new RpcError(ErrorCode.cdpTimeout, "Timed out.");
            }

            return {};
        };

        await runTool(pageWait, { selector: ".x" }, extra(), runtime);

        const expressions = fake.sent
            .filter((call) => call.method === "Runtime.evaluate")
            .map((call) => JSON.stringify(call.params));

        expect(expressions.some((text) => text.includes("__chromiumDevtoolsMcpWaits"))).toBe(true);
    });

    it("terminates execution when a script wait fails", async () => {
        const { fake, runtime } = setup();

        fake.respond = () => {
            throw new RpcError(ErrorCode.cdpError, "Evaluation failed.");
        };

        const result = await runTool(pageWait, { selector: ".x" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(fake.sent.map((call) => call.method)).toContain("Runtime.terminateExecution");
    });

    it("fails fast while a dialog is open", async () => {
        const { fake, runtime } = setup();

        runtime.dialogs.handleCdpEvent({
            targetId: "tab1",
            event   : "Page.javascriptDialogOpening",
            params  : { url: "https://a.example/", message: "stop", type: "alert" },
        });

        const result = await runTool(pageWait, { selector: ".x" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("page_dialogs");
        expect(fake.sent.map((call) => call.method)).toEqual(["Page.enable"]);
    });

    it("rejects a selector combined with url", async () => {
        const { runtime } = setup();
        const result = await runTool(
            pageWait,
            { selector: ".x", url: "/new" },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("not several");
    });
});

describe("page_wait piercing", () => {
    function piercingSetup() {
        const fake = new FakeAccess({
            frames: [
                { frameId: "main", url: "https://a.example/", name: "", isolated: false },
                {
                    frameId      : "cross",
                    parentFrameId: "main",
                    url          : "https://b.example/",
                    name         : "pay",
                    isolated     : true,
                },
            ],
        });

        fake.respond = (_targetId, method) => {
            switch (method) {
                case "Page.createIsolatedWorld":
                    return { executionContextId: 9 };
                case "Runtime.evaluate":
                    return { result: { value: { met: true, detail: { matched: 1, visible: 1 } } } };
                default:
                    throw new Error(`unexpected CDP call ${method}`);
            }
        };

        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

        runtime.tabs.refresh(
            [{ targetId: "tab1", url: "https://a.example/", title: "a", owned: true, created: true }],
            "tab1",
        );

        return { fake, runtime };
    }

    it("builds a pierced selector script that walks shadow roots", () => {
        const script = selectorScript(".x", "visible", 100, 1000, true);

        expect(script).toContain("shadowRoot");
        expect(selectorScript(".x", "visible", 100, 1000)).not.toContain("shadowRoot");
    });

    it("waits in a frame through an isolated world", async () => {
        const { fake, runtime } = piercingSetup();
        const result = await runTool(
            pageWait,
            { selector: "#pay-btn", frame: "cross", timeoutMs: 1000 },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(fake.sent.map((call) => call.method)).toEqual([
            "Page.enable",
            "Page.createIsolatedWorld",
            "Runtime.evaluate",
        ]);
        expect(fake.sent[1]?.params).toMatchObject({ frameId: "cross" });
        expect(fake.sent[2]?.params).toMatchObject({ contextId: 9 });
    });

    it("waits with pierce in the main frame", async () => {
        const { fake, runtime } = piercingSetup();
        const result = await runTool(
            pageWait,
            { selector: "#open-btn", pierce: true, timeoutMs: 1000 },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(fake.sent.map((call) => call.method)).toEqual(["Page.enable", "Runtime.evaluate"]);
        expect(String(fake.sent[1]?.params?.expression)).toContain("shadowRoot");
        expect(fake.sent[1]?.params).not.toHaveProperty("contextId");
    });

    it("reports an unknown frame and rejects pierce without a selector", async () => {
        const { runtime } = piercingSetup();
        const unknown = await runTool(
            pageWait,
            { selector: "#x", frame: "nope" },
            extra(),
            runtime,
        );

        expect(unknown.isError).toBe(true);
        expect(JSON.stringify(unknown.content)).toContain("No frame");

        const misplaced = await runTool(pageWait, { url: "/x", pierce: true }, extra(), runtime);

        expect(misplaced.isError).toBe(true);
        expect(JSON.stringify(misplaced.content)).toContain("only combine with a selector");
    });
});
