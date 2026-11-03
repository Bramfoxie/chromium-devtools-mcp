import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { allTools, runTool, ToolRuntime } from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const restricted: Config = {
    ...managedConfig,
    safety: { ...managedConfig.safety, allowedDomains: ["example.com"] },
};

function tool(name: string) {
    const found = allTools.find((known) => known.name === name);

    if (found === undefined) throw new Error(`Unknown tool ${name}`);

    return found;
}

function text(result: { content: unknown }): string {
    return JSON.stringify(result.content);
}

function tabAt(url: string) {
    return { targetId: "tab1", url, title: "t", owned: true, created: true };
}

function setup(url: string, config: Config = restricted) {
    const fake = new FakeAccess({ tabs: [tabAt(url)] });
    const runtime = new ToolRuntime({ access: fake.asAccess(), config });

    runtime.tabs.select("tab1");

    return { fake, runtime };
}

describe("allowed domains in the tool gate", () => {
    it("refuses a mutating tool on a tab outside the list and keeps reads working", async () => {
        const { fake, runtime } = setup("https://evil.test/");

        const refused = await runTool(tool("click"), { target: { selector: "a" } }, extra(), runtime);

        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain("evil.test");
        expect(text(refused)).toContain("page_navigate");
        expect(fake.sent).toEqual([]);

        const read = await runTool(tool("list_tabs"), {}, extra(), runtime);

        expect(read.isError).not.toBe(true);
    });

    it("lets page_navigate leave a forbidden tab for an allowed URL but not reload it", async () => {
        const { fake, runtime } = setup("https://evil.test/");

        const reload = await runTool(tool("page_navigate"), { action: "reload" }, extra(), runtime);

        expect(reload.isError).toBe(true);
        expect(text(reload)).toContain("evil.test");

        fake.respond = (_tab, method) =>
            method === "Runtime.evaluate"
                ? { result: { type: "object", value: { url: "https://example.com/", title: "t", readyState: "complete" } } }
                : {};

        const away = await runTool(
            tool("page_navigate"),
            { url: "https://example.com/", waitUntil: "none" },
            extra(),
            runtime,
        );

        expect(text(away)).not.toContain("outside safety.allowedDomains");
        expect(fake.sent.some((call) => call.method === "Page.navigate")).toBe(true);
    });

    it("refuses page_navigate and new_tab to a URL outside the list", async () => {
        const { fake, runtime } = setup("https://example.com/");

        const navigate = await runTool(
            tool("page_navigate"),
            { url: "https://evil.test/" },
            extra(),
            runtime,
        );
        const open = await runTool(tool("new_tab"), { url: "https://evil.test/" }, extra(), runtime);

        expect(navigate.isError).toBe(true);
        expect(open.isError).toBe(true);
        expect(fake.created).toEqual([]);
    });

    it("refuses an unreadable tab URL instead of allowing the call", async () => {
        const { fake, runtime } = setup("https://example.com/");

        fake.listTabs = () => Promise.reject(new Error("link down"));

        const result = await runTool(tool("input_key"), { key: "Enter" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("could not be read");
    });

    it("allows close_tab and select_tab on a forbidden tab", async () => {
        const { runtime } = setup("https://evil.test/");

        const closed = await runTool(tool("close_tab"), {}, extra(), runtime);

        expect(closed.isError).not.toBe(true);
    });
});

describe("final URL after navigation", () => {
    function pageState(url: string) {
        return { result: { type: "object", value: { url, title: "t", readyState: "complete" } } };
    }

    it("parks the tab on about:blank and reports when a redirect ends outside the list", async () => {
        const { fake, runtime } = setup("https://example.com/");

        fake.respond = (_tab, method) =>
            method === "Runtime.evaluate" ? pageState("https://evil.test/landing") : {};

        const result = await runTool(
            tool("page_navigate"),
            { url: "https://example.com/redirect", waitUntil: "none" },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("evil.test");
        expect(text(result)).toContain("moved to about:blank");
        expect(text(result)).toContain("safety.allowedDomains");
        expect(fake.sent.at(-1)).toMatchObject({
            method: "Page.navigate",
            params: { url: "about:blank" },
        });
    });

    it("says so when the tab could not be moved away", async () => {
        const { fake, runtime } = setup("https://example.com/");

        fake.respond = (_tab, method) =>
            method === "Runtime.evaluate" ? pageState("https://evil.test/") : {};
        fake.failSend = (_tab, method) =>
            method === "Page.navigate" && fake.sent.length > 3 ? new Error("gone") : undefined;

        const result = await runTool(
            tool("page_navigate"),
            { url: "https://example.com/", waitUntil: "none" },
            extra(),
            runtime,
        );

        expect(text(result)).toContain("could not be moved away");
    });

    it("refuses a history entry outside the list before navigating", async () => {
        const { fake, runtime } = setup("https://example.com/");

        fake.respond = (_tab, method) =>
            method === "Page.getNavigationHistory"
                ? {
                    currentIndex: 1,
                    entries     : [
                        { id: 1, url: "https://evil.test/", title: "" },
                        { id: 2, url: "https://example.com/", title: "" },
                    ],
                }
                : {};

        const result = await runTool(tool("page_navigate"), { action: "back" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("history entry is on evil.test");
        expect(fake.sent.some((call) => call.method === "Page.navigateToHistoryEntry")).toBe(false);
    });

    it("reports a new_tab redirect outside the list as a navigation error and parks the tab", async () => {
        const fake = new FakeAccess();
        const runtime = new ToolRuntime({ access: fake.asAccess(), config: restricted });

        fake.respond = (_tab, method) =>
            method === "Runtime.evaluate" ? pageState("https://evil.test/") : {};

        const result = await runTool(
            tool("new_tab"),
            { url: "https://example.com/", timeoutMs: 1 },
            extra(),
            runtime,
        );
        const body = text(result);

        expect(result.isError).not.toBe(true);
        expect(body).toContain("navigationError");
        expect(body).toContain("evil.test");
        expect(fake.sent.at(-1)).toMatchObject({ params: { url: "about:blank" } });
    });

    it("does nothing without an allowlist", async () => {
        const { fake, runtime } = setup("https://example.com/", managedConfig);

        fake.respond = (_tab, method) =>
            method === "Runtime.evaluate" ? pageState("https://evil.test/") : {};

        const result = await runTool(
            tool("page_navigate"),
            { url: "https://example.com/", waitUntil: "none" },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
    });
});
