export interface TraceEvent {
    pid?         : number;
    tid?         : number;
    ph?          : string;
    cat?         : string;
    name?        : string;
    ts?          : number;
    dur?         : number;
    id?          : string;
    args?        : Record<string, unknown>;
    [key: string]: unknown;
}

export interface FilteredTrace {
    events : TraceEvent[];
    dropped: number;
}

const KEPT_METADATA = new Set(["process_name", "thread_name", "thread_sort_index", "process_sort_index"]);

const STARTED_IN_BROWSER = "TracingStartedInBrowser";

const MAX_DEPTH = 6;

const SCHEME_MARK = "://";

const FRAME_KEY = /^frame(Id)?$/i;

const IDENTITY_KEYS = new Set([
    "url",
    "title",
    "host",
    "hostname",
    "origin",
    "href",
    "domain",
    "message",
    "documentloaderurl",
    "securityorigin",
]);

const PAGE_CHOSEN_CATEGORIES = ["blink.user_timing", "blink.console", "latencyInfo"];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function collectFrames(value: unknown, found: Set<string>, depth = 0): void {
    if (depth > MAX_DEPTH) return;

    if (Array.isArray(value)) {
        for (const item of value) collectFrames(item, found, depth + 1);

        return;
    }

    if (!isRecord(value)) return;

    for (const [key, item] of Object.entries(value)) {
        if (FRAME_KEY.test(key) && typeof item === "string") found.add(item);
        else collectFrames(item, found, depth + 1);
    }
}

function mentionsIdentity(value: unknown, depth = 0): boolean {
    if (typeof value === "string") return value.includes(SCHEME_MARK);

    if (depth > MAX_DEPTH) return true;

    if (Array.isArray(value)) return value.some((item) => mentionsIdentity(item, depth + 1));

    if (!isRecord(value)) return false;

    return Object.entries(value).some(
        ([key, item]) => IDENTITY_KEYS.has(key.toLowerCase()) || mentionsIdentity(item, depth + 1),
    );
}

function pageChosen(event: TraceEvent): boolean {
    const categories = (event.cat ?? "").split(",");

    return PAGE_CHOSEN_CATEGORIES.some((category) => categories.includes(category));
}

function framesOf(event: TraceEvent): Set<string> {
    const found = new Set<string>();

    collectFrames(event.args, found);

    return found;
}

function ownFramesOnly(event: TraceEvent, tabFrames: ReadonlySet<string>): TraceEvent | undefined {
    const data = event.args?.data;

    if (!isRecord(data) || !Array.isArray(data.frames)) return event;

    const frames = data.frames.filter(
        (entry) => isRecord(entry) && typeof entry.frame === "string" && tabFrames.has(entry.frame),
    );

    return frames.length === 0
        ? undefined
        : { ...event, args: { ...event.args, data: { ...data, frames } } };
}

// Keeps the events that name only frames of the tab and the identity free events of its processes.
export function filterTrace(
    events   : readonly TraceEvent[],
    tabFrames: ReadonlySet<string>,
): FilteredTrace {
    const browserPid = events.find((event) => event.name === STARTED_IN_BROWSER)?.pid;
    const tabPids = new Set<number>();
    const frameSets = events.map((event) => framesOf(event));

    events.forEach((event, index) => {
        const own = frameSets[index];

        if (
            event.pid !== undefined && event.pid !== browserPid &&
            own !== undefined && [...own].some((frame) => tabFrames.has(frame))
        ) {
            tabPids.add(event.pid);
        }
    });

    const kept: TraceEvent[] = [];

    events.forEach((event, index) => {
        const frames = frameSets[index] ?? new Set<string>();

        if (event.ph === "M") {
            if (
                event.pid !== undefined && tabPids.has(event.pid) &&
                event.name !== undefined && KEPT_METADATA.has(event.name)
            ) {
                kept.push(event);
            }

            return;
        }

        if (event.name === STARTED_IN_BROWSER) {
            const sanitized = ownFramesOnly(event, tabFrames);

            if (sanitized !== undefined) kept.push(sanitized);

            return;
        }

        if (frames.size > 0) {
            if ([...frames].every((frame) => tabFrames.has(frame))) kept.push(event);

            return;
        }

        if (
            event.pid !== undefined && tabPids.has(event.pid) &&
            !pageChosen(event) && !mentionsIdentity(event.args)
        ) {
            kept.push(event);
        }
    });

    return { events: kept, dropped: events.length - kept.length };
}
