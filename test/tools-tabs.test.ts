import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import {
    closeTab,
    listSessions,
    listTabs,
    mergeMedia,
    newTab,
    popupList,
    runTool,
    selectTab,
    ToolRuntime,
    windowList,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

function setup(config: Config = managedConfig, access?: FakeAccess) {
    const fake = access ?? new FakeAccess();
    const runtime = new ToolRuntime({ access: fake.asAccess(), config });

    return { fake, runtime };
}

function textOf(result: Awaited<ReturnType<typeof runTool>>): string {
    return JSON.stringify(result.content);
}

describe("window_list", () => {
    it("deduplicates owned windows and limits results", async () => {
        const { fake, runtime } = setup();
        const ids = await Promise.all([fake.createTab(), fake.createTab(), fake.createTab()]);

        fake.getWindow = async (id) => ({ windowId: id === ids[2] ? 2 : 1, bounds: {} });
        const result = await runTool(windowList, { limit: 1 }, extra(), runtime);

        expect(result.structuredContent).toEqual({
            windows: [{ windowId: 1, bounds: {} }], total: 2, truncated: true,
        });
    });
});

describe("list_tabs clipping", () => {
    it("clips titles and URLs on code points and marks the omission", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        const [tab] = fake.tabs;

        if (tab === undefined) throw new Error("expected a tab");

        tab.title = "\u{1F600}".repeat(600);
        tab.url = `https://example.org/${"a".repeat(2100)}`;

        const result = await runTool(listTabs, {}, extra(), runtime);
        const content = result.structuredContent as {
            tabs: Array<{ title: string; url: string }>;
        };
        const [listed] = content.tabs;

        expect(listed?.title).toBe(
            `${"\u{1F600}".repeat(500)}[truncated: 100 of 600 characters omitted]`,
        );
        expect(listed?.url).toMatch(/\[truncated: \d+ of 2120 characters omitted\]$/);
        expect(listed?.title).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    });
});

describe("new_tab", () => {
    function loading(
        fake    : FakeAccess,
        navigate: Record<string, unknown>,
        events  : Array<Record<string, unknown>> = [],
    ) {
        fake.respond = (targetId, method) => {
            switch (method) {
                case "Page.getFrameTree":
                    return { frameTree: { frame: { id: "main" } } };
                case "Page.navigate":
                    setTimeout(() => {
                        for (const event of events) fake.emit("cdp.event", { targetId, ...event });
                    }, 0);

                    return navigate;
                case "Runtime.evaluate":
                    return {
                        result: {
                            type : "object",
                            value: { url: "https://example.org/final", title: "Final", readyState: "complete" },
                        },
                    };
                default:
                    return {};
            }
        };
    }

    const loaded = [
        {
            event : "Network.responseReceived",
            params: { frameId: "main", loaderId: "L1", type: "Document", response: { status: 200 } },
        },
        { event: "Page.lifecycleEvent", params: { frameId: "main", loaderId: "L1", name: "load" } },
    ];

    it("opens a tab and selects it by default", async () => {
        const { fake, runtime } = setup();

        loading(fake, { loaderId: "L1" }, loaded);
        const result = await runTool(newTab, { url: "https://example.org/" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({
            tab       : { tab: "tab1", url: "https://example.org/final", title: "Final", owned: true, created: true },
            waited    : "load",
            readyState: "complete",
            status    : 200,
        });
        expect(fake.created).toEqual(["tab1"]);
        expect(fake.tabs[0]?.url).toBe("about:blank");
        expect(fake.sent.find((call) => call.method === "Page.navigate")?.params).toEqual({
            url: "https://example.org/",
        });
        expect(runtime.tabs.selected()).toBe("tab1");
    });

    it("keeps the tab and reports why a download or an empty response was not loaded", async () => {
        for (const navigate of [{ isDownload: true }, { errorText: "net::ERR_ABORTED" }]) {
            const { fake, runtime } = setup();

            loading(fake, navigate);
            const result = await runTool(newTab, { url: "https://example.org/f" }, extra(), runtime);

            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toMatchObject({
                tab   : { tab: "tab1", owned: true, created: true },
                waited: "none",
            });
            expect(result.structuredContent).toHaveProperty("navigationError");
            expect(runtime.tabs.selected()).toBe("tab1");
        }
    });

    it("reports a timeout when the page does not finish loading", async () => {
        const fake = new FakeAccess();
        const clock = { now: () => Date.now(), sleep: async () => undefined };
        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig, clock });

        loading(fake, { loaderId: "L1" });
        const result = await runTool(newTab, { url: "https://example.org/", timeoutMs: 50 }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ waited: "timeout", readyState: "complete" });
    });

    it("refuses a URL scheme before creating a tab", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(newTab, { url: "file:///etc/passwd" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("Only http, https and about:blank");
        expect(fake.created).toEqual([]);
    });

    it("opens about:blank when no URL is given and skips the safety target", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(newTab, {}, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ tab: { url: "about:blank" }, waited: "load" });
        expect(fake.created).toEqual(["tab1"]);
        expect(fake.sent.some((call) => call.method === "Page.navigate")).toBe(false);
    });

    it("leaves the selection alone when select is false", async () => {
        const { runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        await runTool(newTab, { select: false }, extra(), runtime);
        expect(runtime.tabs.selected()).toBe("tab1");
    });

    it("refuses a forbidden URL with the daemon message", async () => {
        const fake = new FakeAccess();

        fake.createTab = async () => {
            throw new RpcError(ErrorCode.unsupportedUrl, "Only http, https and about:blank URLs can be opened.");
        };

        const { runtime } = setup(managedConfig, fake);
        const result = await runTool(newTab, { url: "javascript:alert(1)" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("Only http, https and about:blank");
    });

    it("is refused in read-only mode", async () => {
        const readOnly: Config = {
            ...managedConfig,
            safety: { ...managedConfig.safety, readOnly: true },
        };
        const { fake, runtime } = setup(readOnly);
        const result = await runTool(newTab, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("read-only mode");
        expect(fake.created).toEqual([]);
    });

    it("starts console capture for the new tab", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);

        expect(runtime.capture.consoleEnabled("tab1")).toBe(true);
        expect(runtime.dialogs.pageEnabled("tab1")).toBe(true);
        expect(fake.sent.map((call) => call.method)).toEqual([
            "Runtime.enable",
            "Log.enable",
            "Page.enable",
        ]);
        expect(fake.subscribed).toContainEqual({
            targetId: "tab1",
            event   : "Runtime.consoleAPICalled",
        });
        expect(fake.subscribed).toContainEqual({
            targetId: "tab1",
            event   : "Page.javascriptDialogOpening",
        });
    });

    it("opens the tab even when console capture fails", async () => {
        const fake = new FakeAccess();

        fake.failSend = () => new RpcError(ErrorCode.cdpError, "No such target");
        const { runtime } = setup(managedConfig, fake);
        const result = await runTool(newTab, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ tab: { tab: "tab1" } });
    });
});

describe("list_tabs", () => {
    it("lists owned tabs and marks the selected one", async () => {
        const { runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(listTabs, {}, extra(), runtime);

        expect(result.structuredContent).toMatchObject({
            tabs: [
                { tab: "tab1", selected: false },
                { tab: "tab2", selected: true },
            ],
        });
    });

    it("clears a selection that is no longer owned", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        fake.tabs = [];
        const result = await runTool(listTabs, {}, extra(), runtime);

        expect(result.structuredContent).toEqual({ tabs: [], total: 0, truncated: false });
        expect(runtime.tabs.selected()).toBeUndefined();
    });

    it("lists available tabs without touching the selection", async () => {
        const fake = new FakeAccess({
            tabs: [
                { targetId: "user1", url: "https://user.example/", title: "user tab", owned: false, created: false },
            ],
        });
        const { runtime } = setup(managedConfig, fake);

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(listTabs, { scope: "available" }, extra(), runtime);

        expect(result.structuredContent).toEqual({
            tabs: [
                {
                    tab     : "user1",
                    url     : "https://user.example/",
                    title   : "user tab",
                    owned   : false,
                    created : false,
                    selected: false,
                },
            ],
            total    : 1,
            truncated: false,
        });
        expect(runtime.tabs.selected()).toBe("tab1");
    });
});

describe("select_tab", () => {
    it("selects an owned tab", async () => {
        const { runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(selectTab, { tab: "tab1" }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ tab: { tab: "tab1" } });
        expect(runtime.tabs.selected()).toBe("tab1");
    });

    it("claims an available tab and selects it", async () => {
        const fake = new FakeAccess({
            tabs: [
                { targetId: "user1", url: "https://user.example/", title: "user tab", owned: false, created: false },
            ],
        });
        const { runtime } = setup(managedConfig, fake);
        const result = await runTool(selectTab, { tab: "user1" }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({
            tab: { tab: "user1", owned: true, created: false },
        });
        expect(fake.claimed).toEqual(["user1"]);
        expect(runtime.tabs.selected()).toBe("user1");
    });

    it("starts console capture for a claimed tab", async () => {
        const fake = new FakeAccess({
            tabs: [
                { targetId: "user1", url: "https://user.example/", title: "user tab", owned: false, created: false },
            ],
        });
        const { runtime } = setup(managedConfig, fake);

        await runTool(selectTab, { tab: "user1" }, extra(), runtime);

        expect(runtime.capture.consoleEnabled("user1")).toBe(true);
    });

    it("reports an unknown tab with an action", async () => {
        const { runtime } = setup();
        const result = await runTool(selectTab, { tab: "nope" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("Call list_tabs");
    });

    it("reports a tab used by another session with an action", async () => {
        const fake = new FakeAccess();

        fake.claimTab = async () => {
            throw new RpcError(ErrorCode.alreadyClaimed, "The tab is already used by another session.");
        };

        const { runtime } = setup(managedConfig, fake);
        const result = await runTool(selectTab, { tab: "busy" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("another session");
    });
});

describe("close_tab", () => {
    it("closes the selected tab and moves the selection", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(closeTab, {}, extra(), runtime);

        expect(result.structuredContent).toEqual({ closed: "tab2", selected: "tab1" });
        expect(fake.closed).toEqual(["tab2"]);
        expect(runtime.tabs.selected()).toBe("tab1");
    });

    it("closes another tab and keeps the selection", async () => {
        const { runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(closeTab, { tab: "tab1" }, extra(), runtime);

        expect(result.structuredContent).toEqual({ closed: "tab1", selected: "tab2" });
        expect(runtime.tabs.selected()).toBe("tab2");
    });

    it("reports no selection when the last tab closes", async () => {
        const { runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(closeTab, {}, extra(), runtime);

        expect(result.structuredContent).toEqual({ closed: "tab1", selected: null });
        expect(runtime.tabs.selected()).toBeUndefined();
    });

    it("refuses to close a claimed tab with an explanation", async () => {
        const fake = new FakeAccess({
            tabs: [
                { targetId: "user1", url: "https://user.example/", title: "user tab", owned: true, created: false },
            ],
        });
        const { runtime } = setup(managedConfig, fake);
        const result = await runTool(closeTab, { tab: "user1" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("released when the session ends");
        expect(fake.tabs).toHaveLength(1);
    });

    it("forgets the capture of the closed tab", async () => {
        const { runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        expect(runtime.capture.consoleEnabled("tab1")).toBe(true);
        runtime.emulation.applyMedia("tab1", mergeMedia(undefined, { colorScheme: "dark" }));
        await runTool(closeTab, {}, extra(), runtime);

        expect(runtime.capture.consoleEnabled("tab1")).toBe(false);
        expect(runtime.emulation.snapshot("tab1").media).toBeUndefined();
    });

    it("names new_tab when no tab is selected", async () => {
        const { runtime } = setup();
        const result = await runTool(closeTab, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("new_tab");
    });

    it("points at list_tabs when the tab is already gone", async () => {
        const { runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        runtime.tabs.select("ghost");
        const result = await runTool(closeTab, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("Call list_tabs");
    });
});

describe("list_sessions", () => {
    it("lists sessions without tab details", async () => {
        const fake = new FakeAccess({
            sessions: [
                { sessionId: "session1", clientName: "a", isolated: false, tabs: 2, own: true },
                { sessionId: "session2", clientName: "b", isolated: true, tabs: 0, own: false },
            ],
        });
        const { runtime } = setup(managedConfig, fake);
        const result = await runTool(listSessions, {}, extra(), runtime);

        expect(result.structuredContent).toEqual({
            sessions: [
                { sessionId: "session1", clientName: "a", isolated: false, tabs: 2, own: true },
                { sessionId: "session2", clientName: "b", isolated: true, tabs: 0, own: false },
            ],
        });
    });

    it("works in read-only mode", async () => {
        const readOnly: Config = {
            ...managedConfig,
            safety: { ...managedConfig.safety, readOnly: true },
        };
        const { runtime } = setup(readOnly);
        const result = await runTool(listSessions, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
    });
});

describe("frame tracking on tabs", () => {
    it("starts frame tracking for a new tab", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);

        expect(runtime.frames.ensured("tab1")).toBe(true);
        expect(fake.subscribed).toContainEqual({
            targetId: "tab1",
            event   : "Page.frameNavigated",
        });
    });

    it("forgets frame state when the tab closes", async () => {
        const { runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        expect(runtime.frames.ensured("tab1")).toBe(true);
        await runTool(closeTab, {}, extra(), runtime);
        expect(runtime.frames.ensured("tab1")).toBe(false);
    });
});

describe("popup_list", () => {
    it("lists blank and redirected popup URLs under active domain rules", async () => {
        const config: Config = {
            ...managedConfig,
            safety: { ...managedConfig.safety, allowedDomains: ["allowed.example"] },
        };
        const { fake, runtime } = setup(config);

        await runTool(newTab, {}, extra(), runtime);
        fake.tabs.push({ targetId: "popup", url: "about:blank", title: "", owned: false, created: false });
        const blank = await runTool(popupList, {}, extra(), runtime);

        expect(blank.structuredContent).toMatchObject({ popups: [{ url: "about:blank" }] });
        const popup = fake.tabs.find((tab) => tab.targetId === "popup");

        if (!popup) throw new Error("Missing popup");

        popup.url = "https://blocked.example/redirected";
        const redirected = await runTool(popupList, {}, extra(), runtime);

        expect(redirected.structuredContent).toMatchObject({
            popups: [{ url: "https://blocked.example/redirected" }],
        });
    });

    it("cancels while waiting between discovery attempts", async () => {
        const { runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        const controller = new AbortController();
        const listing = runTool(
            popupList, { timeoutMs: 500 }, { signal: controller.signal } as Extra, runtime,
        );

        setTimeout(() => controller.abort(), 10);
        expect((await listing).isError).toBe(true);
    });

    it("honors cancellation while popup discovery is pending", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => { release = resolve; });

        fake.listPopups = async () => {
            await gate;

            return [{ targetId: "popup", url: "about:blank", title: "", owned: false, created: false }];
        };

        const controller = new AbortController();
        const listing = runTool(
            popupList, { timeoutMs: 500 }, { signal: controller.signal } as Extra, runtime,
        );

        await Promise.resolve();
        controller.abort();
        release();
        const result = await listing;

        expect(result.isError).toBe(true);
    });

    it("limits returned popups and reports truncation", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);

        for (let i = 0; i < 101; i++) {
            fake.tabs.push({ targetId: `popup${i}`, url: "about:blank", title: "", owned: false, created: false });
        }

        const result = await runTool(popupList, {}, extra(), runtime);
        const content = result.structuredContent as {
            popups: unknown[]; total: number; truncated: boolean;
        };

        expect(content.popups).toHaveLength(100);
        expect(content.total).toBe(101);
        expect(content.truncated).toBe(true);
    });

    it("filters baseline IDs and waits for a new popup without claiming it", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        fake.tabs.push({ targetId: "old", url: "about:blank", title: "", owned: false, created: false });
        const initial = await runTool(popupList, {}, extra(), runtime);

        expect(initial.structuredContent).toMatchObject({ popups: [{ tab: "old" }], timedOut: false });
        setTimeout(() => fake.tabs.push({ targetId: "new", url: "about:blank", title: "", owned: false, created: false }), 20);
        const result = await runTool(popupList, { baselineIds: ["old"], timeoutMs: 500 }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ popups: [{ tab: "new" }], timedOut: false });
        expect(fake.claimed).toEqual([]);
        const timeout = await runTool(popupList, { baselineIds: ["old", "new"], timeoutMs: 10 }, extra(), runtime);

        expect(timeout.structuredContent).toEqual({
            popups: [], timedOut: true, total: 0, truncated: false,
        });
    });
});
