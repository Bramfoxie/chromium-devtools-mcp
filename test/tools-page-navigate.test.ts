import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
    navigationWaitReduce,
    navigationWaitStart,
    newTab,
    pageNavigate,
    PAGE_STATE_EXPRESSION,
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

function pageState(url: string, title = "t", readyState = "complete") {
    return { result: { type: "object", value: { url, title, readyState } } };
}

function trackingSleep() {
    const calls: number[] = [];
    const clock = {
        now  : () => 0,
        sleep: (ms: number) => {
            calls.push(ms);

            return new Promise<void>(() => undefined);
        },
    };

    return { clock, calls };
}

describe("navigationWaitReduce", () => {
    it("completes on the wanted lifecycle event of the current loader", () => {
        let state = navigationWaitStart("loader-1");

        state = navigationWaitReduce(
            state,
            { type: "response", loaderId: "loader-1", status: 200 },
            "load",
        );

        expect(state).toEqual({ loaderId: "loader-1", navigated: false, stopped: false, status: 200, done: false });

        state = navigationWaitReduce(
            state,
            { type: "lifecycle", loaderId: "loader-1", name: "load" },
            "load",
        );

        expect(state.done).toBe(true);
    });

    it("ignores events of a stale loader and the wrong lifecycle name", () => {
        let state = navigationWaitStart("loader-2");

        state = navigationWaitReduce(
            state,
            { type: "lifecycle", loaderId: "loader-1", name: "load" },
            "load",
        );
        state = navigationWaitReduce(
            state,
            { type: "response", loaderId: "loader-1", status: 404 },
            "load",
        );
        state = navigationWaitReduce(
            state,
            { type: "lifecycle", loaderId: "loader-2", name: "DOMContentLoaded" },
            "load",
        );

        expect(state).toEqual({ loaderId: "loader-2", navigated: false, stopped: false, status: undefined, done: false });
    });

    it("follows the latest navigation and waits for domcontentloaded when asked", () => {
        let state = navigationWaitStart();

        state = navigationWaitReduce(
            state,
            { type: "navigated", loaderId: "loader-1" },
            "domcontentloaded",
        );
        state = navigationWaitReduce(
            state,
            { type: "navigated", loaderId: "loader-2" },
            "domcontentloaded",
        );
        state = navigationWaitReduce(
            state,
            { type: "lifecycle", loaderId: "loader-1", name: "DOMContentLoaded" },
            "domcontentloaded",
        );

        expect(state.done).toBe(false);

        state = navigationWaitReduce(
            state,
            { type: "lifecycle", loaderId: "loader-2", name: "DOMContentLoaded" },
            "domcontentloaded",
        );

        expect(state).toEqual({ loaderId: "loader-2", navigated: true, stopped: false, status: undefined, done: true });
    });

    it("keeps the last document status of the navigation", () => {
        let state = navigationWaitStart("loader-1");

        state = navigationWaitReduce(
            state,
            { type: "response", loaderId: "loader-1", status: 200 },
            "load",
        );
        state = navigationWaitReduce(
            state,
            { type: "response", loaderId: "loader-1", status: 500 },
            "load",
        );

        expect(state.status).toBe(500);
    });

    it("remembers a response that arrives before the loader is known", () => {
        let state = navigationWaitStart();

        state = navigationWaitReduce(
            state,
            { type: "response", loaderId: "loader-9", status: 200 },
            "load",
        );

        expect(state).toEqual({ loaderId: "loader-9", navigated: false, stopped: false, status: 200, done: false });
    });

    it("drops the status when another navigation commits", () => {
        let state = navigationWaitStart("loader-1");

        state = navigationWaitReduce(
            state,
            { type: "response", loaderId: "loader-1", status: 200 },
            "load",
        );
        state = navigationWaitReduce(state, { type: "navigated", loaderId: "loader-2" }, "load");

        expect(state).toEqual({ loaderId: "loader-2", navigated: true, stopped: false, status: undefined, done: false });
    });

    it("completes on frame stop after navigation for cache restored pages", () => {
        let state = navigationWaitStart();

        state = navigationWaitReduce(state, { type: "stopped", loaderId: undefined }, "load");

        expect(state.done).toBe(false);

        state = navigationWaitReduce(state, { type: "navigated", loaderId: "loader-1" }, "load");

        expect(state.done).toBe(true);

        state = navigationWaitReduce(state, { type: "stopped", loaderId: "loader-1" }, "load");

        expect(state.done).toBe(true);
        expect(state).toEqual({
            loaderId : "loader-1",
            navigated: true,
            stopped  : true,
            status   : undefined,
            done     : true,
        });
    });

    it("ignores a stop from the old page after navigation", () => {
        let state = navigationWaitStart();

        state = navigationWaitReduce(state, { type: "navigated", loaderId: "loader-9" }, "load");

        expect(state.done).toBe(false);

        state = navigationWaitReduce(state, { type: "stopped", loaderId: "loader-1" }, "load");

        expect(state.done).toBe(false);
        expect(state.stopped).toBe(false);
    });

    it("finishes a fragment navigation within the document", () => {
        let state = navigationWaitStart();

        state = navigationWaitReduce(state, { type: "sameDocument" }, "load");

        expect(state.done).toBe(true);
    });
});

describe("page_navigate", () => {
    it("navigates to a url and waits for the load event of the new loader", async () => {
        const fake = new FakeAccess();
        const { clock } = trackingSleep();

        fake.respond = (_targetId, method) => {
            switch (method) {
                case "Page.getFrameTree":
                    return { frameTree: { frame: { id: "main" } } };
                case "Page.navigate":
                    return { loaderId: "loader-9" };
                case "Runtime.evaluate":
                    return pageState("https://example.org/", "Example");
                default:
                    return {};
            }
        };

        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig, clock });

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const pending = runTool(
            pageNavigate,
            { url: "https://example.org/" },
            extra(),
            runtime,
        );

        await vi.waitFor(() =>
            expect(fake.subscribed).toContainEqual({ targetId: "tab1", event: "Page.lifecycleEvent" }),
        );
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Page.lifecycleEvent",
            params  : { frameId: "main", loaderId: "loader-1", name: "load" },
        });
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Network.responseReceived",
            params  : { frameId: "main", loaderId: "loader-9", type: "Document", response: { status: 200 } },
        });
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Page.lifecycleEvent",
            params  : { frameId: "main", loaderId: "loader-9", name: "load" },
        });
        const result = await pending;

        expect(result.structuredContent).toEqual({
            tab           : "tab1",
            url           : "https://example.org/",
            title         : "Example",
            status        : 200,
            waited        : "load",
            navigationType: "url",
        });
        expect(fake.sent.map((call) => call.method)).toEqual([
            "Page.getFrameTree",
            "Page.enable",
            "Page.setLifecycleEventsEnabled",
            "Network.enable",
            "Page.navigate",
            "Page.setLifecycleEventsEnabled",
            "Network.disable",
            "Runtime.evaluate",
        ]);
        expect(fake.sent[4]?.params).toEqual({ url: "https://example.org/" });
        expect(fake.sent[2]?.params).toEqual({ enabled: true });
        expect(fake.sent[5]?.params).toEqual({ enabled: false });
        expect(fake.sent[7]?.params).toMatchObject({ expression: PAGE_STATE_EXPRESSION });
        expect(fake.unsubscribed).toHaveLength(5);
    });

    it("leaves network capture of the tab alone", async () => {
        const fake = new FakeAccess();
        const { clock } = trackingSleep();

        fake.respond = (_targetId, method) => {
            switch (method) {
                case "Page.getFrameTree":
                    return { frameTree: { frame: { id: "main" } } };
                case "Page.navigate":
                    return { loaderId: "loader-9" };
                case "Runtime.evaluate":
                    return pageState("https://example.org/", "Example");
                default:
                    return {};
            }
        };

        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig, clock });

        await runTool(newTab, {}, extra(), runtime);
        await runtime.capture.ensureNetwork("tab1");
        fake.sent.length = 0;
        fake.subscribed.length = 0;

        const pending = runTool(
            pageNavigate,
            { url: "https://example.org/" },
            extra(),
            runtime,
        );

        await vi.waitFor(() =>
            expect(fake.subscribed).toContainEqual({ targetId: "tab1", event: "Page.lifecycleEvent" }),
        );
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Page.lifecycleEvent",
            params  : { frameId: "main", loaderId: "loader-9", name: "load" },
        });
        const result = await pending;

        expect(result.structuredContent).toMatchObject({ waited: "load" });
        expect(fake.sent.map((call) => call.method)).not.toContain("Network.enable");
        expect(fake.sent.map((call) => call.method)).not.toContain("Network.disable");
        expect(fake.unsubscribed.map((entry) => entry.event).sort()).toEqual(
            fake.subscribed.map((entry) => entry.event).sort(),
        );
        expect(runtime.capture.networkEnabled("tab1")).toBe(true);
    });

    it("unsubscribes only the events it subscribed when a subscription fails", async () => {
        const fake = new FakeAccess();
        const { clock } = trackingSleep();

        fake.respond = (_targetId, method) =>
            method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } } : {};

        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig, clock });

        await runTool(newTab, {}, extra(), runtime);
        fake.subscribed.length = 0;

        const original = fake.subscribe.bind(fake);

        fake.subscribe = async (targetId, event, frameId) => {
            if (event === "Page.lifecycleEvent") throw new Error("subscribe failed");

            await original(targetId, event, frameId);
        };

        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

        const result = await runTool(
            pageNavigate,
            { url: "https://example.org/" },
            extra(),
            runtime,
        );
        const logged = stderr.mock.calls.map((call) => String(call[0])).join("");

        stderr.mockRestore();

        expect(logged).toContain("subscribe failed");
        expect(result.isError).toBe(true);
        expect(fake.unsubscribed.map((entry) => entry.event)).toEqual(
            fake.subscribed.map((entry) => entry.event),
        );
    });

    it("takes the status only from the main frame document", async () => {
        const fake = new FakeAccess();
        const { clock } = trackingSleep();

        fake.respond = (_targetId, method) => {
            switch (method) {
                case "Page.getFrameTree":
                    return { frameTree: { frame: { id: "main" } } };
                case "Runtime.evaluate":
                    return pageState("https://example.org/", "Example");
                default:
                    return {};
            }
        };

        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig, clock });

        await runTool(newTab, {}, extra(), runtime);
        const pending = runTool(pageNavigate, { action: "reload" }, extra(), runtime);

        await vi.waitFor(() =>
            expect(
                fake.subscribed.filter((entry) => entry.event === "Network.responseReceived"),
            ).toHaveLength(1),
        );
        await vi.waitFor(() => expect(fake.sent.map((call) => call.method)).toContain("Page.reload"));
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Network.responseReceived",
            params  : {
                frameId : "sub",
                loaderId: "loader-sub",
                type    : "Document",
                response: { status: 500 },
            },
        });
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Network.responseReceived",
            params  : {
                frameId : "main",
                loaderId: "loader-2",
                type    : "Document",
                response: { status: 200 },
            },
        });
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Page.lifecycleEvent",
            params  : { frameId: "main", loaderId: "loader-2", name: "load" },
        });

        const result = await pending;

        expect(result.structuredContent).toMatchObject({ status: 200, waited: "load" });
    });

    it("ignores events of other tabs and other frames", async () => {
        const fake = new FakeAccess();
        const { clock } = trackingSleep();

        fake.respond = (_targetId, method) => {
            switch (method) {
                case "Page.getFrameTree":
                    return { frameTree: { frame: { id: "main" } } };
                case "Page.reload":
                    return {};
                case "Runtime.evaluate":
                    return pageState("https://example.org/", "Example", "loading");
                default:
                    return {};
            }
        };

        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig, clock });

        await runTool(newTab, {}, extra(), runtime);
        await runTool(newTab, {}, extra(), runtime);
        const pending = runTool(pageNavigate, { action: "reload", tab: "tab1" }, extra(), runtime);

        await vi.waitFor(() =>
            expect(
                fake.subscribed.filter((entry) => entry.targetId === "tab1").map((entry) => entry.event),
            ).toContain("Network.responseReceived"),
        );
        fake.emit("cdp.event", {
            targetId: "tab2",
            event   : "Page.lifecycleEvent",
            params  : { frameId: "main", loaderId: "loader-9", name: "load" },
        });
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Page.frameNavigated",
            params  : { frame: { id: "sub", loaderId: "loader-sub" } },
        });
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Page.frameNavigated",
            params  : { frame: { id: "main", loaderId: "loader-9" } },
        });
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Page.lifecycleEvent",
            params  : { frameId: "main", loaderId: "loader-9", name: "load" },
        });
        const result = await pending;

        expect(result.structuredContent).toMatchObject({
            tab           : "tab1",
            waited        : "load",
            navigationType: "reload",
        });
        expect("status" in (result.structuredContent as Record<string, unknown>)).toBe(false);
    });

    it("goes back and forward through the history entries", async () => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) => {
            switch (method) {
                case "Page.getNavigationHistory":
                    return {
                        currentIndex: 1,
                        entries     : [
                            { id: 11, url: "https://a.example/", title: "a" },
                            { id: 12, url: "https://b.example/", title: "b" },
                            { id: 13, url: "https://c.example/", title: "c" },
                        ],
                    };
                case "Runtime.evaluate":
                    return pageState("https://a.example/", "a");
                default:
                    return {};
            }
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;
        fake.subscribed.length = 0;

        const back = await runTool(pageNavigate, { action: "back", waitUntil: "none" }, extra(), runtime);

        expect(back.structuredContent).toMatchObject({ waited: "none", navigationType: "back" });
        expect(fake.sent.map((call) => call.method)).toEqual([
            "Page.getNavigationHistory",
            "Page.navigateToHistoryEntry",
            "Runtime.evaluate",
        ]);
        expect(fake.sent[1]?.params).toEqual({ entryId: 11 });
        expect(fake.subscribed).toEqual([]);

        const forward = await runTool(
            pageNavigate,
            { action: "forward", waitUntil: "none" },
            extra(),
            runtime,
        );

        expect(forward.structuredContent).toMatchObject({ navigationType: "forward" });
        expect(fake.sent[4]?.params).toEqual({ entryId: 13 });
    });

    it("reports a missing history entry without navigating", async () => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) => {
            if (method === "Page.getNavigationHistory") {
                return { currentIndex: 0, entries: [{ id: 11, url: "https://a.example/", title: "a" }] };
            }

            return {};
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(
            pageNavigate,
            { action: "back", waitUntil: "none" },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("no page to go back");
        expect(fake.sent.map((call) => call.method)).toEqual(["Page.getNavigationHistory"]);
    });

    it("refuses to go back or forward to an entry that is not http, https or about:blank", async () => {
        for (const url of [
            "file:///etc/hosts",
            "chrome://settings/",
            "data:text/html,hello",
            "view-source:https://a.example/",
            "chrome-error://chromewebdata/",
            "",
        ]) {
            for (const action of ["back", "forward"] as const) {
                const fake = new FakeAccess();

                fake.respond = (_targetId, method) => {
                    if (method === "Page.getNavigationHistory") {
                        return {
                            currentIndex: 1,
                            entries     : [
                                { id: 11, url: action === "back" ? url : "https://a.example/", title: "x" },
                                { id: 12, url: "https://b.example/", title: "b" },
                                { id: 13, url: action === "forward" ? url : "https://c.example/", title: "x" },
                            ],
                        };
                    }

                    return {};
                };

                const { runtime } = setup(fake);

                await runTool(newTab, {}, extra(), runtime);
                fake.sent.length = 0;

                const result = await runTool(pageNavigate, { action, waitUntil: "none" }, extra(), runtime);

                expect(result.isError).toBe(true);
                expect(JSON.stringify(result.content)).toContain("Only http, https and about:blank");
                expect(fake.sent.map((call) => call.method)).toEqual(["Page.getNavigationHistory"]);
            }
        }
    });

    it("goes back to an about:blank entry", async () => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) => {
            if (method === "Page.getNavigationHistory") {
                return {
                    currentIndex: 1,
                    entries     : [
                        { id: 11, url: "about:blank", title: "" },
                        { id: 12, url: "https://b.example/", title: "b" },
                    ],
                };
            }

            return {};
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(pageNavigate, { action: "back", waitUntil: "none" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(fake.sent.map((call) => call.method)).toContain("Page.navigateToHistoryEntry");
    });

    it("returns a tool error naming the navigation error text", async () => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) => {
            if (method === "Page.navigate") return { errorText: "net::ERR_NAME_NOT_RESOLVED" };

            return {};
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(
            pageNavigate,
            { url: "https://missing.example/", waitUntil: "none" },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("net::ERR_NAME_NOT_RESOLVED");
    });

    it.each([
        [{ errorText: "net::ERR_ABORTED", isDownload: true }, "file download"],
        [{ errorText: "net::ERR_ABORTED", isDownload: false }, "aborted"],
    ])("explains an aborted navigation %j", async (reply, text) => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) => (method === "Page.navigate" ? reply : {});

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(
            pageNavigate,
            { url: "https://x.example/file", waitUntil: "none" },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(text);
        expect(JSON.stringify(result.content)).not.toContain("net::");
    });

    it("returns the known page state when the wait times out", async () => {
        const fake = new FakeAccess();
        let releaseSleep: () => void = () => undefined;
        const clock = {
            now  : () => 0,
            sleep: () => new Promise<void>((resolve) => {
                releaseSleep = resolve;
            }),
        };

        fake.respond = (_targetId, method) => {
            switch (method) {
                case "Page.getFrameTree":
                    return { frameTree: { frame: { id: "main" } } };
                case "Page.navigate":
                    return { loaderId: "loader-9" };
                case "Runtime.evaluate":
                    return pageState("https://slow.example/", "Slow", "loading");
                default:
                    return {};
            }
        };

        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig, clock });

        await runTool(newTab, {}, extra(), runtime);
        const pending = runTool(
            pageNavigate,
            { url: "https://slow.example/", timeoutMs: 100 },
            extra(),
            runtime,
        );

        await vi.waitFor(() =>
            expect(fake.sent.map((call) => call.method)).toContain("Page.navigate"),
        );
        releaseSleep();
        const result = await pending;

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            url           : "https://slow.example/",
            waited        : "timeout",
            navigationType: "url",
            readyState    : "loading",
        });
        expect(fake.unsubscribed.length).toBeGreaterThanOrEqual(1);
    });

    it("fails within timeoutMs when Page.navigate never answers", async () => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) => {
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };

            if (method === "Page.navigate") return new Promise(() => undefined);

            return {};
        };

        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

        await runTool(newTab, {}, extra(), runtime);
        const started = Date.now();
        const result = await runTool(
            pageNavigate,
            { url: "https://slow.example/", timeoutMs: 100 },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("did not start within 100 ms");
        expect(Date.now() - started).toBeLessThan(2000);
        const navigateCall = fake.sent.find((call) => call.method === "Page.navigate");

        expect(navigateCall?.timeoutMs).toBeLessThanOrEqual(100);
    });

    it("stops waiting when the request is cancelled", async () => {
        const fake = new FakeAccess();
        const { clock } = trackingSleep();

        fake.respond = () => ({ frameTree: { frame: { id: "main" } } });
        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig, clock });

        await runTool(newTab, {}, extra(), runtime);
        fake.respond = (_targetId, method) =>
            method === "Page.navigate" ? { frameId: "loader-1" } : {};
        fake.sent.length = 0;
        const controller = new AbortController();
        const pending = runTool(
            pageNavigate,
            { url: "https://example.org/" },
            { signal: controller.signal } as Extra,
            runtime,
        );

        await vi.waitFor(() =>
            expect(fake.sent.map((call) => call.method)).toContain("Page.navigate"),
        );
        controller.abort();
        const result = await pending;

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("cancelled");
        expect(fake.subscribed.map((entry) => entry.event)).toEqual(
            expect.arrayContaining(["Page.lifecycleEvent"]),
        );
    });

    it("invalidates the uid map of the tab", async () => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) =>
            method === "Runtime.evaluate" ? pageState("https://example.org/") : {};
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        runtime.elements.nextGeneration("tab1");
        const [uid] = runtime.elements.assign("tab1", [{ backendNodeId: 5 }]);

        expect(runtime.elements.lookup("tab1", uid ?? "")).toMatchObject({ backendNodeId: 5 });
        await runTool(pageNavigate, { url: "https://example.org/", waitUntil: "none" }, extra(), runtime);

        expect(runtime.elements.lookup("tab1", uid ?? "")).toBeUndefined();
        expect(runtime.elements.generation("tab1")).toBe(2);
    });

    it("requires a tab and a url for the url action", async () => {
        const { runtime } = setup();
        const noTab = await runTool(pageNavigate, { url: "https://example.org/" }, extra(), runtime);

        expect(noTab.isError).toBe(true);
        expect(JSON.stringify(noTab.content)).toContain("new_tab");

        await runTool(newTab, {}, extra(), runtime);
        const noUrl = await runTool(pageNavigate, { waitUntil: "none" }, extra(), runtime);

        expect(noUrl.isError).toBe(true);
        expect(JSON.stringify(noUrl.content)).toContain("needs a url");
    });

    it("exposes the url to the safety gate without changing the decision", () => {
        expect(pageNavigate.target?.({ action: "url", url: "https://example.org/" } as never)).toEqual({
            url: "https://example.org/",
        });
        expect(pageNavigate.target?.({ action: "back" } as never)).toBeUndefined();
        expect(pageNavigate.target?.({ url: "https://example.org/" })).toEqual({
            url: "https://example.org/",
        });
    });
});

describe("page_navigate and private networks", () => {
    const closed = {
        ...managedConfig,
        safety: { ...managedConfig.safety, allowPrivateNetworks: false },
    };

    function runtimeFor(fake: FakeAccess, config = closed) {
        const { clock } = trackingSleep();
        const runtime = new ToolRuntime({
            access     : fake.asAccess(),
            config,
            clock,
            resolveHost: async () => ["93.184.216.34"],
        });

        return runtime;
    }

    function redirecting(landing: string): FakeAccess {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) => {
            switch (method) {
                case "Page.getFrameTree":
                    return { frameTree: { frame: { id: "main" } } };
                case "Page.navigate":
                    return { loaderId: "loader-9" };
                case "Runtime.evaluate":
                    return pageState(landing, "Landed");
                default:
                    return {};
            }
        };

        return fake;
    }

    async function navigate(fake: FakeAccess, config = closed) {
        const runtime = runtimeFor(fake, config);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const pending = runTool(pageNavigate, { url: "https://example.org/" }, extra(), runtime);

        await vi.waitFor(() =>
            expect(fake.subscribed).toContainEqual({ targetId: "tab1", event: "Page.lifecycleEvent" }),
        );
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Network.responseReceived",
            params  : { frameId: "main", loaderId: "loader-9", type: "Document", response: { status: 200 } },
        });
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Page.lifecycleEvent",
            params  : { frameId: "main", loaderId: "loader-9", name: "load" },
        });

        return pending;
    }

    it("parks the tab when a public address redirects to a private one", async () => {
        const fake = redirecting("http://169.254.169.254/latest/meta-data/");
        const result = await navigate(fake);
        const text = JSON.stringify(result.content);

        expect(result.isError).toBe(true);
        expect(text).toContain("169.254.169.254");
        expect(text).toContain("safety.allowPrivateNetworks");
        expect(fake.sent.some((call) =>
            call.method === "Page.navigate"
            && (call.params as { url?: string }).url === "about:blank")).toBe(true);
    });

    it("leaves a navigation that ends on a public address alone", async () => {
        const fake = redirecting("https://example.org/done");
        const result = await navigate(fake);

        expect(result.isError).not.toBe(true);
        expect(fake.sent.some((call) =>
            (call.params as { url?: string } | undefined)?.url === "about:blank")).toBe(false);
    });

    it("follows a private address when the owner allows private networks", async () => {
        const open = { ...closed, safety: { ...closed.safety, allowPrivateNetworks: true } };
        const result = await navigate(redirecting("http://192.168.1.1/admin"), open);

        expect(result.isError).not.toBe(true);
    });

    it("refuses to go back to a private address and a denied host", async () => {
        for (const [entry, setting] of [
            ["http://localhost:3000/", "safety.allowPrivateNetworks"],
            ["https://bad.test/", "safety.deniedDomains"],
        ] as const) {
            const fake = new FakeAccess();

            fake.respond = (_targetId, method) => {
                if (method === "Page.getNavigationHistory") {
                    return {
                        currentIndex: 1,
                        entries     : [
                            { id: 11, url: entry, title: "x" },
                            { id: 12, url: "https://b.example/", title: "b" },
                        ],
                    };
                }

                return {};
            };

            const config = {
                ...closed,
                safety: { ...closed.safety, deniedDomains: ["bad.test"] },
            };
            const runtime = runtimeFor(fake, config);

            await runTool(newTab, {}, extra(), runtime);
            fake.sent.length = 0;

            const result = await runTool(pageNavigate, { action: "back", waitUntil: "none" }, extra(), runtime);

            expect(result.isError).toBe(true);
            expect(JSON.stringify(result.content)).toContain(setting);
            expect(fake.sent.map((call) => call.method)).toEqual(["Page.getNavigationHistory"]);
        }
    });
});
