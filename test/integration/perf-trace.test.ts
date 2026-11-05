import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

const PAGE = `<!doctype html><title>Mine</title><h1 id="h">Mine page</h1>
<img src="/pixel.png" width="300" height="200">
<button id="slow" onclick="const t = Date.now(); while (Date.now() - t < 260) {} this.textContent = 'done'">slow</button>
<script>
  const t = Date.now(); while (Date.now() - t < 120) {}
  setTimeout(() => document.body.insertAdjacentHTML("afterbegin", "<div style='height:80px'>shift</div>"), 300);
</script>`;

const PIXEL = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcAAAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/mine", { body: PAGE, status: 200, type: "text/html" });
    env.fixture.pages.set("/pixel.png", { body: PIXEL, status: 200, type: "image/png" });
    env.fixture.pages.set("/OTHER-TAB-PRIVATE-URL", {
        body  : "<!doctype html><title>private-title-xyz</title><h1>private</h1>",
        status: 200,
        type  : "text/html",
    });
});

afterAll(async () => {
    await env?.stop();
});

type Stopped = {
    tab   : string;
    file  : { path: string; bytes: number };
    events: { kept: number; dropped: number; truncated: boolean };
    vitals   : {
        fcpMs?: number;
        lcpMs?: number;
        cls   : number;
        inpMs?: number;
        tbtMs : number;
        shifts: number;
    };
    longTasks: Array<{ durationMs: number }>;
    network  : { requests: number };
    insights : Array<{ id: string; level: string }>;
};

describe.skipIf(!present)("perf_trace in a real browser", () => {
    it("records one tab, keeps the other tabs out of the file and rates the vitals", async () => {
        const other = await env.open("/OTHER-TAB-PRIVATE-URL");
        const mine = await env.open("/mine");

        const started = await env.ok("perf_trace_start", { tab: mine, reload: true });

        expect(started).toMatchObject({ tab: mine, recording: true, reloaded: true });
        await env.ok("page_navigate", { tab: other, action: "reload" });
        await new Promise((resolve) => setTimeout(resolve, 1200));

        const stopped = (await env.ok("perf_trace_stop", { tab: mine })) as unknown as Stopped;
        const text = await readFile(stopped.file.path, "utf8");
        const parsed = JSON.parse(text) as { traceEvents: unknown[] };

        expect(parsed.traceEvents).toHaveLength(stopped.events.kept);
        expect(stopped.file.path.startsWith(env.artifactsDir)).toBe(true);
        expect(stopped.events.dropped).toBeGreaterThan(0);

        for (const secret of ["OTHER-TAB-PRIVATE-URL", "private-title-xyz"]) {
            expect(text).not.toContain(secret);
            expect(JSON.stringify(stopped)).not.toContain(secret);
        }

        expect(text).toContain("/mine");
        expect(stopped.vitals.fcpMs).toBeGreaterThan(0);
        expect(stopped.vitals.lcpMs).toBeGreaterThan(0);
        expect(stopped.vitals.cls).toBeGreaterThan(0);
        expect(stopped.vitals.shifts).toBeGreaterThan(0);
        expect(stopped.longTasks.length).toBeGreaterThan(0);
        expect(stopped.network.requests).toBeGreaterThanOrEqual(2);
        expect(stopped.insights.map((insight) => insight.id)).toEqual(
            expect.arrayContaining(["lcp", "fcp", "cls", "main-thread-blocking"]),
        );
    });

    it("measures the delay of an interaction made during the trace", async () => {
        let inpMs = 0;

        for (let attempt = 0; attempt < 3 && inpMs < 200; attempt += 1) {
            const mine = await env.open("/mine");

            await env.ok("perf_trace_start", { tab: mine });
            await env.ok("input_click", { tab: mine, target: { selector: "#slow" } });
            await env.ok("page_wait", {
                tab       : mine,
                expression: "document.getElementById('slow').textContent === 'done'",
            });
            await new Promise((resolve) => setTimeout(resolve, 1500));

            const stopped = (await env.ok("perf_trace_stop", { tab: mine })) as unknown as Stopped;

            inpMs = stopped.vitals.inpMs ?? 0;
        }

        expect(inpMs).toBeGreaterThanOrEqual(200);
    });

    it("refuses a second trace on the same tab and a stop without a start", async () => {
        const mine = await env.open("/mine");

        await env.ok("perf_trace_start", { tab: mine });
        const again = await env.call("perf_trace_start", { tab: mine });

        expect(again.isError).toBe(true);
        expect(again.text).toContain("already recording");

        await env.ok("perf_trace_stop", { tab: mine });
        const none = await env.call("perf_trace_stop", { tab: mine });

        expect(none.isError).toBe(true);
        expect(none.text).toContain("perf_trace_start");
    });

    it("can record again after a trace, also when the tab was closed during one", async () => {
        const first = await env.open("/mine");

        await env.ok("perf_trace_start", { tab: first });
        await env.ok("close_tab", { tab: first });

        const second = await env.open("/mine");

        await env.ok("perf_trace_start", { tab: second });
        const stopped = (await env.ok("perf_trace_stop", { tab: second })) as unknown as Stopped;

        expect(stopped.events.kept).toBeGreaterThan(0);
    });
});
