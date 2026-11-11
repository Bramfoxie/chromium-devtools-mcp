import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { newTab, pageHistory, runTool, ToolRuntime } from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
const extra = () => ({ signal: new AbortController().signal }) as Extra;

describe("page_history", () => {
    it("returns bounded entries around the current page and redacts address secrets", async () => {
        const fake = new FakeAccess();
        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

        await runTool(newTab, {}, extra(), runtime);
        fake.respond = (_tab, method) => method === "Page.getNavigationHistory" ? {
            currentIndex: 2,
            entries     : Array.from({ length: 5 }, (_, i) => ({ id: i, url: `https://example.com/${i}?token=secret`, title: `Page ${i}` })),
        } : {};
        const result = await runTool(pageHistory, { limit: 3 }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ tab: "tab1", currentIndex: 2, total: 5, truncated: true });
        const entries = result.structuredContent?.entries as Array<{ index: number }>;

        expect(entries.map((entry) => entry.index)).toEqual([1, 2, 3]);
        expect(JSON.stringify(result)).not.toContain("secret");
    });

    it("rejects an invalid current history index", async () => {
        const fake = new FakeAccess();
        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

        await runTool(newTab, {}, extra(), runtime);
        fake.respond = () => ({ currentIndex: 5, entries: [] });
        const result = await runTool(pageHistory, {}, extra(), runtime);

        expect(result.isError).toBe(true);
    });
});
