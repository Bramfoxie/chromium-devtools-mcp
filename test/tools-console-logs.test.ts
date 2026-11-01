import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { consoleLogs, newTab, runTool, ToolRuntime } from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

function setup(access?: FakeAccess) {
    const fake = access ?? new FakeAccess();
    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

    runtime.capture.attach();

    return { fake, runtime };
}

function consoleCall(targetId: string, type: string, text: string) {
    return {
        targetId,
        event : "Runtime.consoleAPICalled",
        params: { type, args: [{ type: "string", value: text }] },
    };
}

describe("console_logs", () => {
    it("reads buffered entries of the selected tab", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        fake.emit("cdp.event", consoleCall("tab1", "log", "hello"));
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Runtime.exceptionThrown",
            params  : { exceptionDetails: { text: "Uncaught boom" } },
        });
        const result = await runTool(consoleLogs, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            tab          : "tab1",
            nextAfterId  : 2,
            droppedCount : 0,
            returned     : 2,
            totalBuffered: 2,
        });
        const shown = result.structuredContent as { entries: unknown };

        expect(shown.entries).toEqual([
            { id: 1, time: expect.any(String), level: "info", source: "console", text: "hello" },
            { id: 2, time: expect.any(String), level: "error", source: "exception", text: "Uncaught boom" },
        ]);
    });

    it("enables capture lazily for a tab that never had it", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        runtime.capture.forget("tab1");
        fake.sent.length = 0;
        const result = await runTool(consoleLogs, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(fake.sent.map((call) => call.method)).toEqual(["Runtime.enable", "Log.enable"]);
        expect(runtime.capture.consoleEnabled("tab1")).toBe(true);
    });

    it("filters by level and text with paging and order", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        fake.emit("cdp.event", consoleCall("tab1", "log", "alpha one"));
        fake.emit("cdp.event", consoleCall("tab1", "error", "beta two"));
        fake.emit("cdp.event", consoleCall("tab1", "warning", "alpha three"));

        const levels = await runTool(consoleLogs, { levels: ["error", "warning"] }, extra(), runtime);
        const kept = levels.structuredContent as { entries: Array<{ text: string }> };

        expect(kept.entries.map(({ text }) => text)).toEqual(["beta two", "alpha three"]);

        const text = await runTool(
            consoleLogs,
            { textContains: "alpha", order: "newest" },
            extra(),
            runtime,
        );
        const ordered = text.structuredContent as {
            entries    : Array<{ id: number }>;
            nextAfterId: number;
        };

        expect(ordered.entries.map(({ id }) => id)).toEqual([3, 1]);
        expect(ordered.nextAfterId).toBe(3);

        const page = await runTool(consoleLogs, { afterId: 1, limit: 1 }, extra(), runtime);
        const sliced = page.structuredContent as { entries: unknown[]; nextAfterId: number };

        expect(sliced.entries).toHaveLength(1);
        expect(sliced.nextAfterId).toBe(2);
    });

    it("clears the buffer after reading when asked", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        fake.emit("cdp.event", consoleCall("tab1", "log", "once"));

        const cleared = await runTool(consoleLogs, { clear: true }, extra(), runtime);

        expect((cleared.structuredContent as { returned: number }).returned).toBe(1);

        const next = await runTool(consoleLogs, {}, extra(), runtime);

        expect((next.structuredContent as { returned: number }).returned).toBe(0);
        expect((next.structuredContent as { totalBuffered: number }).totalBuffered).toBe(0);
    });

    it("reads another tab on request and names new_tab without a selection", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        await runTool(newTab, {}, extra(), runtime);
        fake.emit("cdp.event", consoleCall("tab1", "log", "first tab"));
        const result = await runTool(consoleLogs, { tab: "tab1" }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ tab: "tab1", returned: 1 });

        const { runtime: empty } = setup();
        const missing = await runTool(consoleLogs, {}, extra(), empty);

        expect(missing.isError).toBe(true);
        expect(JSON.stringify(missing.content)).toContain("new_tab");
    });

    it("rejects an overlong text filter and a limit above the maximum", async () => {
        const { runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);

        const long = await runTool(consoleLogs, { textContains: "x".repeat(1025) }, extra(), runtime);

        expect(long.isError).toBe(true);

        const capped = await runTool(consoleLogs, { limit: 501 }, extra(), runtime);

        expect(capped.isError).toBe(true);
    });
});
