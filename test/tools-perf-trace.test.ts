import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config/index.js";
import {
    type ArtifactStore,
    pageNavigate,
    perfTraceStart,
    perfTraceStop,
    runTool,
    ToolRuntime,
} from "../src/tools/index.js";
import type { TraceEvent } from "../src/tools/perf/trace-filter.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

afterEach(() => {
    vi.restoreAllMocks();
});

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const MAIN = "FRAME-MAIN";
const OTHER = "FRAME-OTHER";
const PID = 9;
const TID = 90;

function traceEvents(): TraceEvent[] {
    return [
        { pid: 1, tid: 1, ph: "I", name: "TracingStartedInBrowser", args: { data: { frames: [{ frame: MAIN }] } } },
        { pid: PID, tid: TID, ph: "M", name: "thread_name", args: { name: "CrRendererMain" } },
        { pid: PID, tid: TID, ph: "R", name: "navigationStart", ts: 1000, args: { frame: MAIN } },
        { pid: PID, tid: TID, ph: "R", name: "firstContentfulPaint", ts: 301_000, args: { frame: MAIN } },
        { pid: PID, tid: TID, ph: "X", name: "RunTask", ts: 400_000, dur: 90_000, args: {} },
        { pid: 2, tid: 2, ph: "X", name: "navigationStart", ts: 1000, args: { frame: OTHER } },
        { pid: 1, tid: 1, ph: "I", name: "UkmPageLoadTimingUpdate", ts: 5, args: { url: "https://private.example/" } },
    ];
}

interface Setup {
    fake   : FakeAccess;
    runtime: ToolRuntime;
    written: Array<{ kind: string; extension: string; data: string }>;
}

function setup(config: Config = managedConfig): Setup {
    const fake = new FakeAccess({
        tabs  : [{ targetId: "tab1", url: "https://a.example/", title: "t", owned: true, created: true }],
        frames: [{ frameId: MAIN, url: "https://a.example/", name: "", isolated: false }],
    });
    const written: Setup["written"] = [];
    const artifacts: ArtifactStore = {
        write: async (kind, extension, data) => {
            written.push({ kind, extension, data: String(data) });

            return { path: `/data/artifacts/${kind}.${extension}`, bytes: String(data).length };
        },
        directory: () => Promise.reject(new Error("not used")),
    };

    fake.respond = (_tab, method) => {
        if (method !== "Tracing.end") return {};

        queueMicrotask(() => {
            fake.emit("cdp.event", {
                targetId: "tab1",
                event   : "Tracing.dataCollected",
                params  : { value: traceEvents().slice(0, 3) },
            });
            fake.emit("cdp.event", {
                targetId: "tab1",
                event   : "Tracing.dataCollected",
                params  : { value: traceEvents().slice(3) },
            });
            fake.emit("cdp.event", { targetId: "tab1", event: "Tracing.tracingComplete", params: {} });
        });

        return {};
    };

    const runtime = new ToolRuntime({ access: fake.asAccess(), config, artifacts });

    runtime.attach();
    runtime.tabs.select("tab1");

    return { fake, runtime, written };
}

const methods = (fake: FakeAccess) => fake.sent.map((call) => call.method);

const text = (result: { content: unknown }) => JSON.stringify(result.content);

describe("perf_trace_start", () => {
    it("holds the rendering, keeps focus emulation on and starts the trace", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(perfTraceStart, {}, extra(), runtime);

        expect(result.structuredContent).toEqual({ tab: "tab1", recording: true, reloaded: false });
        expect(methods(fake)).toEqual([
            "Page.enable",
            "Emulation.setFocusEmulationEnabled",
            "Page.startScreencast",
            "Tracing.start",
        ]);
        expect(
            fake.subscribed.map((entry) => entry.event).filter((event) => event.startsWith("Tracing.")),
        ).toEqual(["Tracing.dataCollected", "Tracing.tracingComplete"]);
    });

    it("reloads the page after the start when asked", async () => {
        const { fake, runtime } = setup();
        const reload = vi.spyOn(pageNavigate, "handler").mockResolvedValue({
            tab           : "tab1",
            url           : "https://a.example/",
            title         : "t",
            waited        : "load",
            navigationType: "reload",
        });
        const result = await runTool(
            perfTraceStart,
            { reload: true, ignoreCache: true },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({ reloaded: true });
        expect(reload).toHaveBeenCalledWith(
            { tab: "tab1", action: "reload", ignoreCache: true },
            expect.anything(),
        );
        expect(methods(fake)).toContain("Tracing.start");
    });

    it("ends the trace when the reload fails, so the next one can start", async () => {
        const { fake, runtime } = setup();

        vi.spyOn(pageNavigate, "handler").mockRejectedValue(new Error("tab went away"));

        const failed = await runTool(perfTraceStart, { reload: true }, extra(), runtime);

        expect(failed.isError).toBe(true);
        expect(runtime.trace.recording("tab1")).toBe(false);
        expect(methods(fake)).toContain("Tracing.end");
        expect(methods(fake)).toContain("Page.stopScreencast");
    });

    it("refuses a second start on the tab", async () => {
        const { runtime } = setup();

        await runTool(perfTraceStart, {}, extra(), runtime);
        const again = await runTool(perfTraceStart, {}, extra(), runtime);

        expect(again.isError).toBe(true);
        expect(text(again)).toContain("already recording");
    });

    it("lets go of everything when the browser refuses the start", async () => {
        const { fake, runtime } = setup();

        fake.failSend = (_tab, method) =>
            method === "Tracing.start" ? new Error("Another trace is recording") : undefined;

        const refused = await runTool(perfTraceStart, {}, extra(), runtime);

        expect(refused.isError).toBe(true);
        expect(methods(fake)).toContain("Page.stopScreencast");
        expect(fake.unsubscribed.map((entry) => entry.event)).toEqual([
            "Tracing.dataCollected",
            "Tracing.tracingComplete",
        ]);

        fake.failSend = undefined;
        const retry = await runTool(perfTraceStart, {}, extra(), runtime);

        expect(retry.isError).not.toBe(true);
    });

    it("is a reading tool unless it reloads, and is refused in read-only mode only then", async () => {
        const readOnly: Config = {
            ...managedConfig,
            safety: { ...managedConfig.safety, readOnly: true },
        };
        const plain = setup(readOnly);
        const reload = setup(readOnly);

        expect((await runTool(perfTraceStart, {}, extra(), plain.runtime)).isError).not.toBe(true);

        const refused = await runTool(perfTraceStart, { reload: true }, extra(), reload.runtime);

        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain("read-only mode");
        expect(methods(reload.fake)).toEqual([]);
    });
});

describe("perf_trace_stop", () => {
    it("ends the trace, filters it to the tab, saves it and reports the summary", async () => {
        const { fake, runtime, written } = setup();

        await runTool(perfTraceStart, {}, extra(), runtime);
        const result = await runTool(perfTraceStop, {}, extra(), runtime);
        const output = result.structuredContent as {
            file  : { path: string };
            events: { kept: number; dropped: number; truncated: boolean };
            vitals: { fcpMs: number };
        };

        expect(result.isError).not.toBe(true);
        expect(output.file.path).toBe("/data/artifacts/perf-trace.json");
        expect(output.events).toEqual({ kept: 5, dropped: 2, truncated: false });
        expect(output.vitals.fcpMs).toBe(300);
        expect(written).toHaveLength(1);
        expect(written[0]).toMatchObject({ kind: "perf-trace", extension: "json" });

        const saved = JSON.parse(written[0]?.data ?? "{}") as { traceEvents: TraceEvent[] };

        expect(saved.traceEvents).toHaveLength(5);
        expect(written[0]?.data).not.toContain("private.example");
        expect(written[0]?.data).not.toContain(OTHER);
        expect(methods(fake)).toContain("Page.stopScreencast");
    });

    it("says so when no trace is recording", async () => {
        const { runtime } = setup();
        const result = await runTool(perfTraceStop, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("perf_trace_start");
    });

    it("drops the trace when the frames of the tab cannot be read", async () => {
        const { fake, runtime, written } = setup();

        await runTool(perfTraceStart, {}, extra(), runtime);
        fake.frames = [];
        const result = await runTool(perfTraceStop, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("frames of the tab could not be read");
        expect(written).toEqual([]);
    });

    it("forgets a trace when its tab is forgotten", async () => {
        const { runtime } = setup();

        await runTool(perfTraceStart, {}, extra(), runtime);
        await runtime.forgetTab("tab1");
        const result = await runTool(perfTraceStop, { tab: "tab1" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("No trace is recording");
    });

    it("can be refused by a missing file directory without losing the browser state", async () => {
        const fake = new FakeAccess({
            tabs  : [{ targetId: "tab1", url: "https://a.example/", title: "t", owned: true, created: true }],
            frames: [{ frameId: MAIN, url: "https://a.example/", name: "", isolated: false }],
        });

        fake.respond = (_tab, method) => {
            if (method === "Tracing.end") {
                queueMicrotask(() =>
                    fake.emit("cdp.event", { targetId: "tab1", event: "Tracing.tracingComplete", params: {} }));
            }

            return {};
        };

        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

        runtime.attach();
        runtime.tabs.select("tab1");

        await runTool(perfTraceStart, {}, extra(), runtime);
        const result = await runTool(perfTraceStop, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("no directory for files");
    });
});
