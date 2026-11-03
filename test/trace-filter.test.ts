import { describe, expect, it } from "vitest";
import { filterTrace, type TraceEvent } from "../src/tools/perf/trace-filter.js";

const BROWSER = 100;
const MINE = 200;
const OTHER = 300;
const GPU = 400;
const MY_FRAME = "FRAME-MINE";
const MY_CHILD = "FRAME-MINE-CHILD";
const OTHER_FRAME = "FRAME-OTHER";

const tabFrames = new Set([MY_FRAME, MY_CHILD]);

const ev = (partial: TraceEvent): TraceEvent => ({ ph: "X", ts: 1, ...partial });

function trace(): TraceEvent[] {
    return [
        ev({
            pid : BROWSER,
            ph  : "I",
            name: "TracingStartedInBrowser",
            args: {
                data: {
                    frames: [
                        { frame: MY_FRAME, url: "https://mine.example/" },
                        { frame: OTHER_FRAME, url: "https://private.example/inbox" },
                    ],
                },
            },
        }),
        ev({ pid: MINE, ph: "M", name: "thread_name", args: { name: "CrRendererMain" } }),
        ev({ pid: MINE, ph: "M", name: "process_labels", args: { labels: "Tab: Private inbox" } }),
        ev({ pid: OTHER, ph: "M", name: "thread_name", args: { name: "CrRendererMain" } }),
        ev({ pid: BROWSER, ph: "M", name: "thread_name", args: { name: "CrBrowserMain" } }),
        ev({ pid: MINE, name: "RunTask", dur: 10, args: {} }),
        ev({ pid: MINE, name: "navigationStart", args: { frame: MY_FRAME, data: { documentLoaderURL: "https://mine.example/" } } }),
        ev({ pid: MINE, name: "ParseHTML", args: { beginData: { frame: MY_CHILD, url: "https://child.example/" } } }),
        ev({ pid: MINE, name: "ParseHTML", args: { beginData: { frame: OTHER_FRAME, url: "https://private.example/inbox" } } }),
        ev({ pid: MINE, name: "Mixed", args: { data: { frame: MY_FRAME }, other: { frame: OTHER_FRAME } } }),
        ev({ pid: MINE, name: "Untracked", args: { data: { url: "https://leak.example/path" } } }),
        ev({ pid: MINE, name: "Untracked", args: { note: "mailto://someone" } }),
        ev({ pid: MINE, name: "MinorGC", dur: 5, args: { usedHeapSizeBefore: 10 } }),
        ev({ pid: OTHER, name: "RunTask", dur: 99, args: {} }),
        ev({ pid: OTHER, name: "navigationStart", args: { frame: OTHER_FRAME } }),
        ev({ pid: BROWSER, name: "FrameCommittedInBrowser", args: { data: { frame: MY_FRAME, url: "https://mine.example/" } } }),
        ev({ pid: BROWSER, name: "FrameCommittedInBrowser", args: { data: { frame: OTHER_FRAME, url: "https://private.example/inbox" } } }),
        ev({ pid: BROWSER, name: "UkmPageLoadTimingUpdate", args: { url: "https://private.example/inbox" } }),
        ev({ pid: BROWSER, name: "Generic", args: {} }),
        ev({ pid: GPU, name: "GPUTask", dur: 3, args: {} }),
    ];
}

const names = (events: TraceEvent[]) => events.map((event) => `${event.pid}:${event.name}`);

describe("filterTrace", () => {
    const result = filterTrace(trace(), tabFrames);
    const json = JSON.stringify(result.events);

    it("keeps what belongs to the frames of the tab and the metadata of its processes", () => {
        expect(names(result.events)).toEqual([
            `${BROWSER}:TracingStartedInBrowser`,
            `${MINE}:thread_name`,
            `${MINE}:RunTask`,
            `${MINE}:navigationStart`,
            `${MINE}:ParseHTML`,
            `${MINE}:MinorGC`,
            `${BROWSER}:FrameCommittedInBrowser`,
        ]);
    });

    it("drops every address and label of another tab", () => {
        for (const secret of ["private.example", "Private inbox", "FRAME-OTHER", "leak.example", "mailto"]) {
            expect(json).not.toContain(secret);
        }
    });

    it("cuts the list of frames in the start event down to the tab", () => {
        const started = result.events.find((event) => event.name === "TracingStartedInBrowser");
        const frames = (started?.args?.data as { frames: Array<{ frame: string }> }).frames;

        expect(frames.map((entry) => entry.frame)).toEqual([MY_FRAME]);
    });

    it("drops events of the browser, other renderers and helper processes that name no frame of the tab", () => {
        const pids = new Set(result.events.map((event) => event.pid));

        expect(pids.has(OTHER)).toBe(false);
        expect(pids.has(GPU)).toBe(false);
        expect(names(result.events)).not.toContain(`${BROWSER}:Generic`);
    });

    it("reports how many events were dropped", () => {
        expect(result.dropped).toBe(trace().length - result.events.length);
    });

    it("returns nothing when the tab has no frames in the trace", () => {
        expect(filterTrace(trace(), new Set(["unknown"])).events).toEqual([]);
    });

    it("keeps the events of a process that is shared with another tab only when they are not foreign", () => {
        const shared = [
            ev({ pid: MINE, name: "navigationStart", args: { frame: MY_FRAME } }),
            ev({ pid: MINE, name: "navigationStart", args: { frame: OTHER_FRAME } }),
            ev({ pid: MINE, name: "RunTask", dur: 4, args: {} }),
        ];

        expect(names(filterTrace(shared, tabFrames).events)).toEqual([
            `${MINE}:navigationStart`,
            `${MINE}:RunTask`,
        ]);
    });
});
