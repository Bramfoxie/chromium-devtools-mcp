import { describe, expect, it } from "vitest";
import type { TraceEvent } from "../src/tools/perf/trace-filter.js";
import { summarizeTrace } from "../src/tools/perf/trace-summary.js";

const MAIN = "FRAME-MAIN";
const PID = 7;
const TID = 70;
const MS = 1000;

const ev = (partial: TraceEvent): TraceEvent => ({ pid: PID, tid: TID, ph: "X", ...partial });

const base = 1_000 * MS;

function load(): TraceEvent[] {
    return [
        { pid: PID, tid: TID, ph: "M", name: "thread_name", args: { name: "CrRendererMain" } },
        { pid: PID, tid: 71, ph: "M", name: "thread_name", args: { name: "Compositor" } },
        ev({ ph: "R", name: "navigationStart", ts: 5 * MS, args: { frame: MAIN, data: { documentLoaderURL: "" } } }),
        ev({ ph: "R", name: "navigationStart", ts: base, args: { frame: MAIN, data: { documentLoaderURL: "https://a.example/" } } }),
        ev({ ph: "R", name: "firstContentfulPaint", ts: base + 600 * MS, args: { frame: MAIN } }),
        ev({
            ph  : "R",
            name: "largestContentfulPaint::Candidate",
            ts  : base + 1_000 * MS,
            args: { frame: MAIN, data: { candidateIndex: 1, nodeName: "H1", type: "text", size: 100 } },
        }),
        ev({
            ph  : "R",
            name: "largestContentfulPaint::Candidate",
            ts  : base + 2_400 * MS,
            args: { frame: MAIN, data: { candidateIndex: 2, nodeName: "IMG id='hero'", type: "image", size: 9000 } },
        }),
        ev({ ph: "I", name: "LayoutShift", ts: base + 1_000 * MS, args: { frame: MAIN, data: { score: 0.05 } } }),
        ev({ ph: "I", name: "LayoutShift", ts: base + 1_500 * MS, args: { frame: MAIN, data: { score: 0.04 } } }),
        ev({ ph: "I", name: "LayoutShift", ts: base + 1_600 * MS, args: { frame: MAIN, data: { score: 0.9, had_recent_input: true } } }),
        ev({ ph: "I", name: "LayoutShift", ts: base + 9_000 * MS, args: { frame: MAIN, data: { score: 0.2 } } }),
        ev({ name: "RunTask", ts: base + 700 * MS, dur: 120 * MS, args: {} }),
        ev({ name: "EvaluateScript", ts: base + 710 * MS, dur: 80 * MS, args: { data: { frame: MAIN } } }),
        ev({ name: "FunctionCall", ts: base + 720 * MS, dur: 30 * MS, args: { data: { frame: MAIN } } }),
        ev({ name: "RunTask", ts: base + 1_000 * MS, dur: 60 * MS, args: {} }),
        ev({ name: "UpdateLayoutTree", ts: base + 1_010 * MS, dur: 20 * MS, args: {} }),
        ev({ name: "Paint", ts: base + 1_031 * MS, dur: 10 * MS, args: {} }),
        ev({ name: "RunTask", ts: base + 1_100 * MS, dur: 30 * MS, args: {} }),
        ev({ name: "MinorGC", ts: base + 1_105 * MS, dur: 10 * MS, args: {} }),
        ev({ name: "RunTask", ts: base + 1_200 * MS, dur: 40 * MS, args: {} }),
        ev({ tid: 71, name: "RunTask", ts: base + 1_300 * MS, dur: 500 * MS, args: {} }),
    ];
}

describe("summarizeTrace", () => {
    const summary = summarizeTrace(load(), MAIN);

    it("measures paints from the last navigation of the main frame", () => {
        expect(summary.vitals).toMatchObject({
            fcpMs: 600,
            lcpMs: 2400,
            lcp  : { element: "IMG id='hero'", type: "image", size: 9000 },
        });
    });

    it("scores layout shifts in session windows and ignores shifts after input", () => {
        expect(summary.vitals.cls).toBe(0.2);
        expect(summary.vitals.shifts).toBe(3);
    });

    it("counts the time over 50 ms of the long tasks after the first paint as blocking", () => {
        expect(summary.vitals.tbtMs).toBe(80);
        expect(summary.longTasks).toEqual([
            { startMs: 700, durationMs: 120 },
            { startMs: 1000, durationMs: 60 },
        ]);
    });

    it("splits the main thread time by activity without counting nested events twice", () => {
        expect(summary.mainThreadMs).toEqual({
            scripting: 80,
            rendering: 20,
            painting : 10,
            loading  : 0,
            gc       : 10,
            other    : 40 + 30 + 20 + 40,
        });
    });

    it("reports a good, warn and poor verdict by the web vitals thresholds", () => {
        const verdict = (id: string) =>
            summary.insights.find((insight) => insight.id === id)?.level;

        expect(verdict("lcp")).toBe("good");
        expect(verdict("fcp")).toBe("good");
        expect(verdict("cls")).toBe("warn");
        expect(verdict("main-thread-blocking")).toBe("good");
    });

    it("works on a trace that holds no paint and no task", () => {
        const empty = summarizeTrace([], MAIN);

        expect(empty.vitals).toEqual({ cls: 0, shifts: 0, interactions: 0, tbtMs: 0 });
        expect(empty.longTasks).toEqual([]);
        expect(empty.durationMs).toBe(0);
    });
});

describe("interactions", () => {
    const timing = (id: string, ph: "b" | "e", ts: number, interactionId = 0): TraceEvent =>
        ev({ ph, id, name: "EventTiming", ts, args: { data: { interactionId } } });

    it("takes the slowest event of each interaction and reports it as the interaction delay", () => {
        const summary = summarizeTrace(
            [
                timing("1", "b", base, 11),
                timing("1", "e", base + 120 * MS),
                timing("2", "b", base + 10 * MS, 11),
                timing("2", "e", base + 60 * MS),
                timing("3", "b", base + 500 * MS, 12),
                timing("3", "e", base + 650 * MS),
                timing("4", "b", base + 900 * MS),
                timing("4", "e", base + 2_900 * MS),
            ],
            MAIN,
        );

        expect(summary.vitals.interactions).toBe(2);
        expect(summary.vitals.inpMs).toBe(150);
        expect(summary.insights.find((insight) => insight.id === "inp")?.level).toBe("good");
    });

    it("uses the 98th percentile once there are fifty interactions", () => {
        const events: TraceEvent[] = [];

        for (let index = 1; index <= 60; index += 1) {
            events.push(timing(String(index), "b", base + index * 10 * MS, index));
            events.push(timing(String(index), "e", base + index * 10 * MS + index * MS));
        }

        const summary = summarizeTrace(events, MAIN);

        expect(summary.vitals.interactions).toBe(60);
        expect(summary.vitals.inpMs).toBe(59);
    });
});

describe("network", () => {
    const request = (id: string, url: string, type = "Script"): TraceEvent =>
        ev({ ph: "I", name: "ResourceSendRequest", ts: base, args: { data: { requestId: id, url, resourceType: type } } });
    const finish = (id: string, bytes: number, didFail = false): TraceEvent =>
        ev({ ph: "I", name: "ResourceFinish", ts: base + MS, args: { data: { requestId: id, encodedDataLength: bytes, didFail } } });

    it("counts requests, failures and transfer and lists the largest with their secrets redacted", () => {
        const summary = summarizeTrace(
            [
                request("a", "https://a.example/app.js?token=secret123"),
                finish("a", 2_000_000),
                request("b", "https://a.example/b.css", "Stylesheet"),
                finish("b", 500),
                request("c", "https://a.example/c.png", "Image"),
                finish("c", 0, true),
            ],
            MAIN,
        );

        expect(summary.network).toMatchObject({ requests: 3, failed: 1, transferBytes: 2_000_500 });
        expect(summary.network.largest[0]).toMatchObject({ type: "Script", bytes: 2_000_000 });
        expect(JSON.stringify(summary.network)).not.toContain("secret123");
        expect(summary.insights.find((insight) => insight.id === "large-resources")?.level).toBe("warn");
    });

    it("counts a request once even when its start event repeats", () => {
        const summary = summarizeTrace([request("a", "https://a.example/x"), request("a", "https://a.example/x")], MAIN);

        expect(summary.network.requests).toBe(1);
    });
});

describe("summarizeTrace on large and edge case traces", () => {
    it("summarizes a trace of 300000 events without running out of stack", () => {
        const events: TraceEvent[] = Array.from({ length: 300_000 }, (_, index) =>
            ev({ name: "RunTask", ts: base + index, dur: 1, args: {} }));
        const summary = summarizeTrace(events, MAIN);

        expect(summary.durationMs).toBeGreaterThan(0);
    });

    it("starts a new layout shift window after a window that scored nothing", () => {
        const shift = (at: number, score: number): TraceEvent =>
            ev({ ph: "I", name: "LayoutShift", ts: base + at * MS, args: { frame: MAIN, data: { score } } });
        const summary = summarizeTrace([shift(0, 0), shift(100, 0.3), shift(200, 0.2)], MAIN);

        expect(summary.vitals.cls).toBe(0.5);
    });

    it("counts only the part of a task after the first paint as blocking", () => {
        const events = [
            { pid: PID, tid: TID, ph: "M", name: "thread_name", args: { name: "CrRendererMain" } },
            ev({ ph: "R", name: "navigationStart", ts: base, args: { frame: MAIN } }),
            ev({ ph: "R", name: "firstContentfulPaint", ts: base + 500 * MS, args: { frame: MAIN } }),
            ev({ name: "RunTask", ts: base + 400 * MS, dur: 200 * MS, args: {} }),
        ];

        expect(summarizeTrace(events, MAIN).vitals.tbtMs).toBe(50);
    });

    it("forgets an interaction start once its end was seen", () => {
        const pair = (id: string): TraceEvent[] => [
            ev({ ph: "b", id, name: "EventTiming", ts: base, args: { data: { interactionId: 5 } } }),
            ev({ ph: "e", id, name: "EventTiming", ts: base + 100 * MS, args: {} }),
        ];
        const summary = summarizeTrace(
            [...pair("1"), ev({ ph: "e", id: "1", name: "EventTiming", ts: base + 900 * MS, args: {} })],
            MAIN,
        );

        expect(summary.vitals.inpMs).toBe(100);
    });
});
