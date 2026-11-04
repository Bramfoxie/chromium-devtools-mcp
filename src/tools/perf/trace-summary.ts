import { redactUrl } from "../capture/redact.js";
import type { TraceEvent } from "./trace-filter.js";

const LONG_TASK_US = 50_000;

const CLS_WINDOW_GAP_US = 1_000_000;

const CLS_WINDOW_MAX_US = 5_000_000;

const INP_PERCENTILE_FROM = 50;

const LONG_TASKS_SHOWN = 5;

const REQUESTS_SHOWN = 5;

const LARGE_RESOURCE_BYTES = 1_000_000;

const URL_MAX_CHARS = 200;

const SCRIPTING = new Set([
    "EvaluateScript",
    "v8.compile",
    "v8.run",
    "FunctionCall",
    "EventDispatch",
    "TimerFire",
    "FireAnimationFrame",
    "FireIdleCallback",
    "RunMicrotasks",
    "V8.Execute",
    "XHRReadyStateChange",
    "XHRLoad",
]);

const RENDERING = new Set([
    "UpdateLayoutTree",
    "Layout",
    "PrePaint",
    "UpdateLayer",
    "HitTest",
    "IntersectionObserverController::computeIntersections",
]);

const PAINTING = new Set([
    "Paint",
    "Layerize",
    "CompositeLayers",
    "Commit",
    "Decode Image",
    "ImageDecodeTask",
    "ImageUncompress",
]);

const LOADING = new Set(["ParseHTML", "ParseAuthorStyleSheet"]);

type Activity = "scripting" | "rendering" | "painting" | "loading" | "gc" | "other";

export type InsightLevel = "good" | "warn" | "poor";

export interface Insight {
    id    : string;
    level : InsightLevel;
    title : string;
    detail: string;
}

export interface TraceSummary {
    durationMs: number;
    vitals: {
        fcpMs?      : number;
        lcpMs?      : number;
        lcp?        : { element?: string; type?: string; size?: number };
        cls         : number;
        shifts      : number;
        inpMs?      : number;
        interactions: number;
        tbtMs       : number;
    };
    mainThreadMs: Record<Activity, number>;
    longTasks   : Array<{ startMs: number; durationMs: number }>;
    network: {
        requests     : number;
        failed       : number;
        transferBytes: number;
        largest      : Array<{ url: string; type: string; bytes: number }>;
    };
    insights: Insight[];
}

function round(value: number, places = 1): number {
    const scale = 10 ** places;

    return Math.round(value * scale) / scale;
}

function data(event: TraceEvent): Record<string, unknown> {
    const value = event.args?.data;

    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function frameOf(event: TraceEvent): unknown {
    return event.args?.frame ?? data(event).frame;
}

function activityOf(name: string): Activity {
    if (SCRIPTING.has(name)) return "scripting";
    if (RENDERING.has(name)) return "rendering";
    if (PAINTING.has(name)) return "painting";
    if (LOADING.has(name)) return "loading";

    if (name === "MinorGC" || name === "MajorGC" || name.startsWith("V8.GC") || name.startsWith("BlinkGC")) {
        return "gc";
    }

    return "other";
}

function mainThreadOf(events: readonly TraceEvent[], mainFrame: string): string | undefined {
    const names = new Map<string, string>();

    for (const event of events) {
        if (event.ph === "M" && event.name === "thread_name") {
            const name = event.args?.name;

            if (typeof name === "string") names.set(`${event.pid}:${event.tid}`, name);
        }
    }

    const hosting = events.find(
        (event) => event.pid !== undefined && frameOf(event) === mainFrame && event.name === "navigationStart",
    ) ?? events.find((event) => frameOf(event) === mainFrame && event.tid !== undefined);

    if (hosting?.pid === undefined) return undefined;

    for (const [key, name] of names) {
        if (name === "CrRendererMain" && key.startsWith(`${hosting.pid}:`)) return key;
    }

    return hosting.tid === undefined ? undefined : `${hosting.pid}:${hosting.tid}`;
}

function selfTimes(tasks: TraceEvent[]): Record<Activity, number> {
    const totals: Record<Activity, number> = {
        scripting: 0,
        rendering: 0,
        painting : 0,
        loading  : 0,
        gc       : 0,
        other    : 0,
    };
    const sorted = [...tasks].sort(
        (a, b) => (a.ts ?? 0) - (b.ts ?? 0) || (b.dur ?? 0) - (a.dur ?? 0),
    );
    const stack: Array<{ end: number; self: number; name: string }> = [];
    const close = (until: number): void => {
        while (stack.length > 0 && (stack.at(-1)?.end ?? 0) <= until) {
            const done = stack.pop();

            if (done !== undefined) totals[activityOf(done.name)] += Math.max(0, done.self);
        }
    };

    for (const task of sorted) {
        const start = task.ts ?? 0;
        const duration = task.dur ?? 0;

        close(start);
        const parent = stack.at(-1);

        if (parent !== undefined) parent.self -= duration;

        stack.push({ end: start + duration, self: duration, name: task.name ?? "" });
    }

    close(Number.POSITIVE_INFINITY);

    return totals;
}

function earliest(events: readonly TraceEvent[]): number {
    let first = Number.POSITIVE_INFINITY;

    for (const event of events) {
        const stamp = event.ts ?? 0;

        if (stamp > 0 && stamp < first) first = stamp;
    }

    return Number.isFinite(first) ? first : 0;
}

function shiftScore(events: readonly TraceEvent[]): { cls: number; count: number } {
    const shifts = events
        .filter((event) => event.name === "LayoutShift" && data(event).had_recent_input !== true)
        .map((event) => ({ ts: event.ts ?? 0, score: Number(data(event).score ?? 0) }))
        .sort((a, b) => a.ts - b.ts);
    let best = 0;
    let windowSum = 0;
    let windowStart = 0;
    let last = 0;
    let open = false;

    for (const shift of shifts) {
        const fresh = !open ||
            shift.ts - last > CLS_WINDOW_GAP_US || shift.ts - windowStart > CLS_WINDOW_MAX_US;

        if (fresh) {
            windowSum = 0;
            windowStart = shift.ts;
            open = true;
        }

        windowSum += shift.score;
        last = shift.ts;
        best = Math.max(best, windowSum);
    }

    return { cls: best, count: shifts.length };
}

function interactionDelay(events: readonly TraceEvent[]): { inpMs?: number; count: number } {
    const begins = new Map<string, TraceEvent>();
    const longest = new Map<number, number>();

    for (const event of events) {
        if (event.name !== "EventTiming" || event.id === undefined) continue;

        if (event.ph === "b") {
            begins.set(event.id, event);
        } else if (event.ph === "e") {
            const begin = begins.get(event.id);

            begins.delete(event.id);
            const interaction = Number(begin === undefined ? 0 : data(begin).interactionId ?? 0);

            if (begin !== undefined && interaction > 0) {
                const duration = ((event.ts ?? 0) - (begin.ts ?? 0)) / 1000;

                longest.set(interaction, Math.max(longest.get(interaction) ?? 0, duration));
            }
        }
    }

    const durations = [...longest.values()].sort((a, b) => b - a);

    if (durations.length === 0) return { count: 0 };

    const at = Math.floor(durations.length / INP_PERCENTILE_FROM);

    const picked = durations[Math.min(at, durations.length - 1)] ?? 0;

    return { inpMs: round(picked), count: durations.length };
}

function clipUrl(url: string): string {
    const redacted = redactUrl(url);

    return redacted.length > URL_MAX_CHARS ? `${redacted.slice(0, URL_MAX_CHARS)}...` : redacted;
}

function networkOf(events: readonly TraceEvent[]): TraceSummary["network"] {
    const sent = new Map<string, { url: string; type: string }>();
    let failed = 0;
    let transfer = 0;
    let requests = 0;
    const finished: Array<{ url: string; type: string; bytes: number }> = [];

    for (const event of events) {
        const info = data(event);
        const requestId = typeof info.requestId === "string" ? info.requestId : undefined;

        if (requestId === undefined) continue;

        if (event.name === "ResourceSendRequest" && !sent.has(requestId)) {
            requests += 1;
            sent.set(requestId, {
                url : typeof info.url === "string" ? info.url : "",
                type: typeof info.resourceType === "string" ? info.resourceType : "Other",
            });
        } else if (event.name === "ResourceFinish") {
            const bytes = Number(info.encodedDataLength ?? 0);
            const request = sent.get(requestId);

            if (info.didFail === true) failed += 1;

            transfer += Number.isFinite(bytes) ? bytes : 0;

            if (request !== undefined && Number.isFinite(bytes)) {
                finished.push({ url: clipUrl(request.url), type: request.type, bytes });
            }
        }
    }

    finished.sort((a, b) => b.bytes - a.bytes);

    return {
        requests,
        failed,
        transferBytes: transfer,
        largest      : finished.slice(0, REQUESTS_SHOWN),
    };
}

function level(value: number, good: number, poor: number): InsightLevel {
    if (value <= good) return "good";

    return value <= poor ? "warn" : "poor";
}

function insightsOf(summary: Omit<TraceSummary, "insights">): Insight[] {
    const found: Insight[] = [];
    const { vitals } = summary;

    if (vitals.lcpMs !== undefined) {
        const what = vitals.lcp?.element === undefined ? "" : ` The largest element is ${vitals.lcp.element}.`;

        found.push({
            id    : "lcp",
            level : level(vitals.lcpMs, 2500, 4000),
            title : `Largest Contentful Paint ${vitals.lcpMs} ms`,
            detail: `Good is 2500 ms or less, poor is above 4000 ms.${what}`,
        });
    }

    if (vitals.fcpMs !== undefined) {
        found.push({
            id    : "fcp",
            level : level(vitals.fcpMs, 1800, 3000),
            title : `First Contentful Paint ${vitals.fcpMs} ms`,
            detail: "Good is 1800 ms or less, poor is above 3000 ms.",
        });
    }

    found.push({
        id    : "cls",
        level : level(vitals.cls, 0.1, 0.25),
        title : `Cumulative Layout Shift ${vitals.cls}`,
        detail: `${vitals.shifts} layout shifts without recent input. Good is 0.1 or less, poor is above 0.25.`,
    });

    if (vitals.inpMs !== undefined) {
        found.push({
            id    : "inp",
            level : level(vitals.inpMs, 200, 500),
            title : `Interaction to Next Paint ${vitals.inpMs} ms`,
            detail: `Measured over ${vitals.interactions} interactions. Good is 200 ms or less, poor is above 500 ms.`,
        });
    }

    found.push({
        id    : "main-thread-blocking",
        level : level(vitals.tbtMs, 200, 600),
        title : `Total Blocking Time ${vitals.tbtMs} ms`,
        detail: `${summary.longTasks.length > 0 ? "Long tasks block the main thread." : "No long task was found."} Good is 200 ms or less, poor is above 600 ms.`,
    });

    const large = summary.network.largest.filter((entry) => entry.bytes >= LARGE_RESOURCE_BYTES);

    if (large.length > 0) {
        found.push({
            id    : "large-resources",
            level : "warn",
            title : `${large.length} resource${large.length === 1 ? "" : "s"} over 1 MB`,
            detail: large.map((entry) => `${entry.url} (${entry.bytes} bytes)`).join("; "),
        });
    }

    return found;
}

export function summarizeTrace(events: readonly TraceEvent[], mainFrame: string): TraceSummary {
    const first = earliest(events);
    const last = events.reduce(
        (end, event) => Math.max(end, (event.ts ?? 0) + (event.dur ?? 0)),
        first,
    );
    const navigations = events.filter(
        (event) => event.name === "navigationStart" && frameOf(event) === mainFrame,
    );
    const base = navigations.at(-1)?.ts ?? first;
    const main = mainThreadOf(events, mainFrame);
    const mainFrames = events.filter(
        (event) => frameOf(event) === mainFrame && (event.ts ?? 0) >= base,
    );
    const fcp = mainFrames.find((event) => event.name === "firstContentfulPaint");
    const candidates = mainFrames.filter((event) => event.name === "largestContentfulPaint::Candidate");
    const lcp = candidates.sort(
        (a, b) => Number(data(a).candidateIndex ?? 0) - Number(data(b).candidateIndex ?? 0),
    ).at(-1);
    const tasks = events.filter(
        (event) => event.ph === "X" && event.dur !== undefined && `${event.pid}:${event.tid}` === main,
    );
    const afterPaint = fcp?.ts ?? base;
    const runTasks = tasks.filter((task) => task.name === "RunTask");
    const longTasks = runTasks.filter((task) => (task.dur ?? 0) > LONG_TASK_US);
    const blocking = longTasks.reduce((sum, task) => {
        const start = Math.max(task.ts ?? 0, afterPaint);
        const inside = (task.ts ?? 0) + (task.dur ?? 0) - start;

        return sum + Math.max(0, inside - LONG_TASK_US);
    }, 0);
    const shift = shiftScore(events.filter((event) => frameOf(event) === mainFrame || event.name !== "LayoutShift"));
    const interactions = interactionDelay(events);
    const totals = selfTimes(tasks);
    const summary: Omit<TraceSummary, "insights"> = {
        durationMs: round((last - first) / 1000),
        vitals    : {
            ...(fcp?.ts === undefined ? {} : { fcpMs: round((fcp.ts - base) / 1000) }),
            ...(lcp?.ts === undefined ? {} : { lcpMs: round((lcp.ts - base) / 1000) }),
            ...(lcp === undefined
                ? {}
                : {
                    lcp: {
                        ...(typeof data(lcp).nodeName === "string" ? { element: String(data(lcp).nodeName) } : {}),
                        ...(typeof data(lcp).type === "string" ? { type: String(data(lcp).type) } : {}),
                        ...(typeof data(lcp).size === "number" ? { size: Number(data(lcp).size) } : {}),
                    },
                }),
            cls         : round(shift.cls, 3),
            shifts      : shift.count,
            ...(interactions.inpMs === undefined ? {} : { inpMs: interactions.inpMs }),
            interactions: interactions.count,
            tbtMs       : round(blocking / 1000),
        },
        mainThreadMs: {
            scripting: round(totals.scripting / 1000),
            rendering: round(totals.rendering / 1000),
            painting : round(totals.painting / 1000),
            loading  : round(totals.loading / 1000),
            gc       : round(totals.gc / 1000),
            other    : round(totals.other / 1000),
        },
        longTasks: longTasks
            .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
            .slice(0, LONG_TASKS_SHOWN)
            .map((task) => ({
                startMs   : round(((task.ts ?? 0) - base) / 1000),
                durationMs: round((task.dur ?? 0) / 1000),
            })),
        network: networkOf(events),
    };

    return { ...summary, insights: insightsOf(summary) };
}
