import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import {
    closeTab,
    listSessions,
    listTabs,
    newTab,
    runTool,
    selectTab,
    ToolRuntime,
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

describe("new_tab", () => {
    it("opens a tab and selects it by default", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(newTab, { url: "https://example.org/" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            tab: { tab: "tab1", url: "https://example.org/", owned: true, created: true },
        });
        expect(fake.created).toEqual(["tab1"]);
        expect(runtime.tabs.selected()).toBe("tab1");
    });

    it("opens about:blank when no URL is given and skips the safety target", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(newTab, {}, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ tab: { url: "about:blank" } });
        expect(fake.created).toEqual(["tab1"]);
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

        expect(result.structuredContent).toEqual({ tabs: [] });
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
