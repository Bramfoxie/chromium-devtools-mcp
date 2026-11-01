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

        state = navigationWaitReduce(state, { type: "stopped" }, "load");

        expect(state.done).toBe(false);

        state = navigationWaitReduce(state, { type: "navigated", loaderId: "loader-1" }, "load");

        expect(state.done).toBe(true);
        expect(state).toEqual({
            loaderId : "loader-1",
            navigated: true,
            stopped  : true,
            status   : undefined,
            done     : true,
        });
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
            params  : { loaderId: "loader-9", type: "Document", response: { status: 200 } },
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
            "Page.disable",
            "Network.disable",
            "Runtime.evaluate",
        ]);
        expect(fake.sent[4]?.params).toEqual({ url: "https://example.org/" });
        expect(fake.sent[2]?.params).toEqual({ enabled: true });
        expect(fake.sent[7]?.params).toMatchObject({ expression: PAGE_STATE_EXPRESSION });
        expect(fake.unsubscribed).toHaveLength(4);
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
            expect(fake.subscribed).toContainEqual({ targetId: "tab1", event: "Page.frameNavigated" }),
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
        expect(fake.unsubscribed).toHaveLength(4);
    });

    it("stops waiting when the request is cancelled", async () => {
        const fake = new FakeAccess();
        const { clock } = trackingSleep();

        fake.respond = () => ({});
        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig, clock });

        await runTool(newTab, {}, extra(), runtime);
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
        expect(fake.unsubscribed).toHaveLength(4);
    });

    it("invalidates the uid map of the tab", async () => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) =>
            method === "Runtime.evaluate" ? pageState("https://example.org/") : {};
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        runtime.elements.nextGeneration("tab1");
        const [uid] = runtime.elements.assign("tab1", [{ backendNodeId: 5 }]);

        expect(runtime.elements.lookup("tab1", uid ?? "")).toBeDefined();
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
        expect(pageNavigate.target?.({ url: "https://example.org/" } as never)).toEqual({
            url: "https://example.org/",
        });
    });
});
