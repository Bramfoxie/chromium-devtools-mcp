import { describe, expect, it } from "vitest";
import {
    CaptureManager,
    clipConsoleText,
    compileUrlPattern,
    formatConsoleArgument,
    formatConsoleStack,
    matchNetworkRecord,
    normalizeConsoleEvent,
    redactHeaders,
    redactUrl,
    reduceNetworkEvent,
    RingBuffer,
    type NetworkRecord,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";

const clock = { now: () => 1_700_000_000_000, sleep: async () => undefined };

function manager(fake = new FakeAccess()) {
    const capture = new CaptureManager({ access: fake.asAccess(), clock });

    capture.attach();

    return { fake, capture };
}

describe("RingBuffer", () => {
    it("evicts the oldest entries past the count limit and reports dropped", () => {
        const buffer = new RingBuffer<string>({ maxEntries: 2, maxBytes: 1000, sizeOf: () => 1 });

        const first = buffer.push("a");
        const second = buffer.push("b");
        const third = buffer.push("c");

        expect([first, second, third]).toEqual([1, 2, 3]);
        expect(buffer.size).toBe(2);
        expect(buffer.dropped).toBe(1);
        expect(buffer.get(1)).toBeUndefined();
        expect(buffer.after(0, 10).map(({ id }) => id)).toEqual([2, 3]);
    });

    it("evicts by bytes and accounts for growth on adjust", () => {
        const buffer = new RingBuffer<string>({
            maxEntries: 100,
            maxBytes  : 4,
            sizeOf    : (value) => value.length,
        });

        buffer.push("ab");
        buffer.push("cd");
        expect(buffer.size).toBe(2);
        buffer.push("ef");
        expect(buffer.size).toBe(2);
        expect(buffer.dropped).toBe(1);
        buffer.adjust(2, 10);
        expect(buffer.size).toBe(1);
        expect(buffer.dropped).toBe(2);
        expect(buffer.bytes).toBe(2);
    });

    it("keeps ids monotonic with afterId paging and clears the counters", () => {
        const buffer = new RingBuffer<string>({ maxEntries: 10, maxBytes: 1000, sizeOf: () => 1 });

        buffer.push("a");
        buffer.push("b");
        expect(buffer.after(1, 10).map(({ id }) => id)).toEqual([2]);
        expect(buffer.after(2, 10)).toEqual([]);
        buffer.clear();
        expect(buffer.size).toBe(0);
        expect(buffer.dropped).toBe(0);
        expect(buffer.bytes).toBe(0);
        expect(buffer.push("c")).toBe(3);
    });

    it("notifies evictions in order", () => {
        const evicted: number[] = [];
        const buffer = new RingBuffer<string>({
            maxEntries: 1,
            maxBytes  : 1000,
            sizeOf    : () => 1,
            onEvict   : (id) => void evicted.push(id),
        });

        buffer.push("a");
        buffer.push("b");
        buffer.push("c");

        expect(evicted).toEqual([1, 2]);
    });
});

describe("console formatting", () => {
    it("formats primitives, summaries and unserializable values", () => {
        expect(formatConsoleArgument({ type: "string", value: "hi" })).toBe("hi");
        expect(formatConsoleArgument({ type: "number", value: 42 })).toBe("42");
        expect(formatConsoleArgument({ type: "boolean", value: false })).toBe("false");
        expect(formatConsoleArgument({ type: "undefined" })).toBe("undefined");
        expect(formatConsoleArgument({ type: "object", subtype: "array", description: "Array(3)" })).toBe(
            "Array(3)",
        );
        expect(formatConsoleArgument({ type: "object", subtype: "null", value: null })).toBe("null");
        expect(formatConsoleArgument({ type: "number", unserializableValue: "Infinity" })).toBe(
            "Infinity",
        );
        expect(formatConsoleArgument({ type: "object" })).toBe("Object");
    });

    it("clips long text and long stacks", () => {
        expect(clipConsoleText("x".repeat(3000))).toBe(`${"x".repeat(2000)}...`);
        const frames = Array.from({ length: 30 }, (_, index) => ({
            functionName: `f${index}`,
            url         : "https://a.example/x.js",
            lineNumber  : index,
            columnNumber: 1,
        }));

        expect(formatConsoleStack(frames).split("\n")).toHaveLength(20);
        expect(formatConsoleStack(frames)).toContain("f0 (https://a.example/x.js:1:2)");
    });

    it("normalizes a console call with location and stack", () => {
        const entry = normalizeConsoleEvent("Runtime.consoleAPICalled", {
            type      : "warning",
            args      : [{ type: "string", value: "careful" }, { type: "number", value: 7 }],
            stackTrace: {
                callFrames: [
                    { functionName: "main", url: "https://a.example/app.js", lineNumber: 9, columnNumber: 4 },
                ],
            },
        }, "2026-01-01T00:00:00.000Z");

        expect(entry).toEqual({
            time  : "2026-01-01T00:00:00.000Z",
            level : "warning",
            source: "console",
            text  : "careful 7",
            url   : "https://a.example/app.js",
            line  : 10,
            column: 5,
            stack : "main (https://a.example/app.js:10:5)",
        });
    });

    it("maps console types and log levels to severities", () => {
        const call = (type: string) =>
            normalizeConsoleEvent("Runtime.consoleAPICalled", { type, args: [] }, "t")?.level;
        const log = (level: string) =>
            normalizeConsoleEvent("Log.entryAdded", { entry: { source: "network", level, text: "x" } }, "t")
                ?.level;

        expect(call("error")).toBe("error");
        expect(call("assert")).toBe("error");
        expect(call("debug")).toBe("debug");
        expect(call("table")).toBe("info");
        expect(log("error")).toBe("error");
        expect(log("warning")).toBe("warning");
        expect(log("verbose")).toBe("debug");
        expect(log("info")).toBe("info");
    });

    it("normalizes exceptions with their description and browser entries", () => {
        const thrown = normalizeConsoleEvent("Runtime.exceptionThrown", {
            exceptionDetails: {
                text        : "Uncaught",
                lineNumber  : 3,
                columnNumber: 8,
                url         : "https://a.example/app.js",
                exception   : { type: "object", subtype: "error", description: "TypeError: bad\n    at f" },
            },
        }, "t");

        expect(thrown).toMatchObject({
            level : "error",
            source: "exception",
            text  : "TypeError: bad\n    at f",
            url   : "https://a.example/app.js",
            line  : 4,
            column: 9,
        });

        const browser = normalizeConsoleEvent("Log.entryAdded", {
            entry: {
                source    : "security",
                level     : "error",
                text      : "CSP blocked",
                url       : "https://a.example/",
                lineNumber: 0,
            },
        }, "t");

        expect(browser).toMatchObject({
            level : "error",
            source: "browser",
            text  : "CSP blocked",
            url   : "https://a.example/",
            line  : 1,
        });
    });

    it("rejects unknown events and malformed payloads", () => {
        expect(normalizeConsoleEvent("Page.loadEventFired", {}, "t")).toBeUndefined();
        expect(normalizeConsoleEvent("Runtime.consoleAPICalled", { type: "log" }, "t")).toBeUndefined();
        expect(normalizeConsoleEvent("Runtime.exceptionThrown", {}, "t")).toBeUndefined();
        expect(normalizeConsoleEvent("Log.entryAdded", { entry: { text: 5 } }, "t")).toBeUndefined();
    });
});

describe("network reduction", () => {
    const sent = (overrides = {}) => ({
        requestId: "r1",
        request  : { url: "https://a.example/data.json?token=abc", method: "GET" },
        timestamp: 100,
        initiator: { type: "fetch" },
        type     : "XHR",
        ...overrides,
    });

    it("assembles a record from the event sequence with redacted values", () => {
        const records = new Map<string, NetworkRecord>();
        const find = (id: string) => records.get(id);
        const first = reduceNetworkEvent("Network.requestWillBeSent", sent(), find);

        expect(first?.created).toBe(true);
        records.set("r1", first?.record as NetworkRecord);

        const response = reduceNetworkEvent(
            "Network.responseReceived",
            {
                requestId: "r1",
                timestamp: 101,
                type     : "XHR",
                response : {
                    url       : "https://a.example/data.json?token=abc",
                    status    : 200,
                    statusText: "OK",
                    mimeType  : "application/json",
                    headers   : { "content-type": "application/json", authorization: "Bearer x" },
                },
            },
            find,
        );

        expect(response?.created).toBe(false);

        const finished = reduceNetworkEvent(
            "Network.loadingFinished",
            { requestId: "r1", timestamp: 101.5, encodedDataLength: 1200 },
            find,
        );

        expect(finished?.created).toBe(false);

        const record = records.get("r1");

        expect(record).toMatchObject({
            method      : "GET",
            url         : "https://a.example/data.json?token=[redacted]",
            resourceType: "XHR",
            status      : 200,
            statusText  : "OK",
            mimeType    : "application/json",
            fromCache   : false,
            failed      : false,
            finished    : true,
            durationMs  : 1500,
            encodedBytes: 1200,
            initiator   : "fetch",
        });
        expect(record?.responseHeaders).toEqual({
            "content-type": "application/json",
            authorization : "[redacted]",
        });
    });

    it("links redirect chains and records failures, cache and websockets", () => {
        const records = new Map<string, NetworkRecord>();
        const find = (id: string) => records.get(id);

        const first = reduceNetworkEvent(
            "Network.requestWillBeSent",
            sent({ requestId: "redir" }),
            find,
        );

        records.set("redir", first?.record as NetworkRecord);

        const second = reduceNetworkEvent(
            "Network.requestWillBeSent",
            sent({
                requestId       : "redir",
                timestamp       : 101,
                redirectResponse: {
                    url       : "https://a.example/old",
                    status    : 302,
                    statusText: "Found",
                    headers   : {},
                },
            }),
            find,
        );

        expect(second?.redirected).toBe(true);
        expect(records.get("redir")).toMatchObject({ redirect: true, finished: true, status: 302 });

        const failed = reduceNetworkEvent(
            "Network.loadingFailed",
            { requestId: "gone", timestamp: 5, type: "Script", errorText: "net::ERR_ABORTED" },
            find,
        );

        expect(failed?.created).toBe(true);
        expect(failed?.record).toMatchObject({ failed: true, finished: true, errorText: "net::ERR_ABORTED" });
        records.set("gone", failed?.record as NetworkRecord);

        const cached = reduceNetworkEvent(
            "Network.requestServedFromCache",
            { requestId: "gone" },
            find,
        );

        expect(cached?.created).toBe(false);
        expect(records.get("gone")?.fromCache).toBe(true);

        const socket = reduceNetworkEvent(
            "Network.webSocketCreated",
            { requestId: "ws1", url: "wss://a.example/chat?session=zzz" },
            find,
        );

        expect(socket?.record).toMatchObject({
            url         : "wss://a.example/chat?session=[redacted]",
            resourceType: "WebSocket",
        });
    });

    it("merges a repeated request without a redirect into one record", () => {
        const records = new Map<string, NetworkRecord>();
        const find = (id: string) => records.get(id);

        const first = reduceNetworkEvent("Network.requestWillBeSent", sent(), find);

        records.set("r1", first?.record as NetworkRecord);

        const repeat = reduceNetworkEvent(
            "Network.requestWillBeSent",
            sent({ type: "Document", timestamp: 101 }),
            find,
        );

        expect(repeat?.created).toBe(false);
        expect(repeat?.record).toBe(records.get("r1"));
        expect(records.get("r1")).toMatchObject({ method: "GET", resourceType: "Document" });
    });

    it("creates stub records for out of order events and rejects malformed ones", () => {
        const stub = reduceNetworkEvent(
            "Network.responseReceived",
            {
                requestId: "late",
                timestamp: 3,
                response : { url: "https://a.example/x", status: 200, statusText: "OK", headers: {} },
            },
            () => undefined,
        );

        expect(stub?.created).toBe(true);
        expect(stub?.record.method).toBe("");
        expect(reduceNetworkEvent("Network.loadingFinished", { requestId: "x" }, () => undefined))
            .toBeUndefined();
        expect(reduceNetworkEvent("Page.loadEventFired", {}, () => undefined)).toBeUndefined();
    });
});

describe("redaction", () => {
    it("redacts sensitive query values and keeps the rest", () => {
        expect(redactUrl("https://a.example/x?token=abc&page=2")).toBe(
            "https://a.example/x?token=[redacted]&page=2",
        );
        expect(redactUrl("https://a.example/x?APIKEY=abc#frag")).toBe(
            "https://a.example/x?APIKEY=[redacted]#frag",
        );
        expect(redactUrl("https://a.example/x?next=https%3A%2F%2Fb.example%2F%3Fkey%3D1")).toBe(
            "https://a.example/x?next=https%3A%2F%2Fb.example%2F%3Fkey%3D1",
        );
        expect(redactUrl("https://a.example/plain")).toBe("https://a.example/plain");
    });

    it("redacts sensitive headers by name and keeps the names", () => {
        expect(
            redactHeaders({ Authorization: "a", "content-type": "text/html", "x-token-id": "t" }),
        ).toEqual({
            Authorization : "[redacted]",
            "content-type": "text/html",
            "x-token-id"  : "[redacted]",
        });
    });
});

describe("url pattern", () => {
    it("compiles patterns and matches records with the guards", () => {
        const record: NetworkRecord = {
            requestId   : "r1",
            method      : "GET",
            url         : "https://a.example/items/42",
            resourceType: "XHR",
            status      : 200,
            fromCache   : false,
            failed      : false,
            finished    : true,
            redirect    : false,
        };

        expect(matchNetworkRecord(record, {})).toBe(true);
        expect(matchNetworkRecord(record, { urlContains: "items" })).toBe(true);
        expect(matchNetworkRecord(record, { urlContains: "other" })).toBe(false);
        expect(matchNetworkRecord(record, { urlPattern: compileUrlPattern("items/\\d+") })).toBe(true);
        expect(matchNetworkRecord(record, { methods: ["POST"] })).toBe(false);
        expect(matchNetworkRecord(record, { resourceTypes: ["XHR"] })).toBe(true);
        expect(matchNetworkRecord(record, { statusMin: 200, statusMax: 299 })).toBe(true);
        expect(matchNetworkRecord(record, { statusMin: 500 })).toBe(false);
        expect(matchNetworkRecord(record, { failedOnly: true })).toBe(false);
        expect(() => compileUrlPattern("(unclosed")).toThrow(/valid regular expression/);
        expect(() => compileUrlPattern(`x{${"1".repeat(300)}}`)).toThrow(/longer than 200/);
    });
});

describe("CaptureManager", () => {
    function consoleCall(text: string) {
        return {
            targetId: "tab1",
            event   : "Runtime.consoleAPICalled",
            params  : { type: "log", args: [{ type: "string", value: text }] },
        };
    }

    it("enables console capture once per tab and network capture lazily", async () => {
        const { fake, capture } = manager();

        await capture.ensureConsole("tab1");
        await capture.ensureConsole("tab1");
        expect(fake.sent.map((call) => call.method)).toEqual(["Runtime.enable", "Log.enable"]);
        expect(fake.subscribed).toEqual([
            { targetId: "tab1", event: "Runtime.consoleAPICalled" },
            { targetId: "tab1", event: "Runtime.exceptionThrown" },
            { targetId: "tab1", event: "Log.entryAdded" },
        ]);
        expect(capture.consoleEnabled("tab1")).toBe(true);
        expect(capture.networkEnabled("tab1")).toBe(false);

        await capture.ensureNetwork("tab1");
        await capture.ensureNetwork("tab1");
        expect(fake.sent.map((call) => call.method)).toEqual([
            "Runtime.enable",
            "Log.enable",
            "Network.enable",
        ]);
        expect(fake.subscribed.filter(({ event }) => event.startsWith("Network."))).toHaveLength(6);
    });

    it("buffers console entries with paging and dropped counts", async () => {
        const { fake, capture } = manager();

        await capture.ensureConsole("tab1");
        fake.emit("cdp.event", consoleCall("first"));
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Log.entryAdded",
            params  : { entry: { source: "network", level: "error", text: "failed" } },
        });
        fake.emit("cdp.event", { ...consoleCall("other tab ignored"), targetId: "tab2" });

        const page = capture.readConsole("tab1", { limit: 10, order: "oldest", clear: false });

        expect(page.entries.map(({ entry }) => entry.text)).toEqual(["first", "failed"]);
        expect(page.entries[0]?.entry.time).toBe("2023-11-14T22:13:20.000Z");
        expect(page.nextAfterId).toBe(2);
        expect(page.droppedCount).toBe(0);
        expect(page.totalBuffered).toBe(2);

        const next = capture.readConsole("tab1", {
            afterId: 1,
            limit  : 10,
            order  : "newest",
            clear  : false,
        });

        expect(next.entries.map(({ entry }) => entry.text)).toEqual(["failed"]);

        const cleared = capture.readConsole("tab1", { limit: 10, order: "oldest", clear: true });

        expect(cleared.entries).toHaveLength(2);
        expect(capture.readConsole("tab1", { limit: 10, order: "oldest", clear: false }).entries)
            .toEqual([]);
    });

    it("ignores events for unknown tabs and malformed envelopes", () => {
        const { fake, capture } = manager();

        fake.emit("cdp.event", consoleCall("no tab yet"));
        fake.emit("cdp.event", { nonsense: true });
        fake.emit("tab.closed", { targetId: 5 });

        expect(capture.readConsole("tab1", { limit: 10, order: "oldest", clear: false }).entries)
            .toEqual([]);
    });

    it("assembles network records and links redirects", async () => {
        const { fake, capture } = manager();

        await capture.ensureNetwork("tab1");
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Network.requestWillBeSent",
            params  : {
                requestId: "r1",
                request  : { url: "https://a.example/old?key=1", method: "GET" },
                timestamp: 10,
                type     : "Document",
            },
        });
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Network.requestWillBeSent",
            params  : {
                requestId       : "r1",
                request         : { url: "https://a.example/new", method: "GET" },
                timestamp       : 11,
                type            : "Document",
                redirectResponse: { url: "https://a.example/old?key=1", status: 301, statusText: "Moved", headers: {} },
            },
        });
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Network.loadingFinished",
            params  : { requestId: "r1", timestamp: 12, encodedDataLength: 50 },
        });

        const read = capture.readNetwork("tab1", { filter: {}, afterId: undefined, limit: 10, clear: false });

        expect(read.records.map(({ record }) => record.url)).toEqual([
            "https://a.example/old?key=[redacted]",
            "https://a.example/new",
        ]);
        expect(read.records[0]?.record.redirect).toBe(true);
        expect(read.records[1]).toMatchObject({
            id    : 2,
            record: { redirectedFrom: 1, finished: true, encodedBytes: 50 },
        });
        expect(capture.networkRecord("tab1", 2)?.record.url).toBe("https://a.example/new");
        expect(capture.networkRecord("tab1", 99)).toBeUndefined();
    });

    it("forgets a tab on tab.closed and everything on reset", async () => {
        const { fake, capture } = manager();

        await capture.ensureConsole("tab1");
        await capture.ensureNetwork("tab1");
        fake.emit("cdp.event", consoleCall("before close"));
        fake.emit("tab.closed", { targetId: "tab1" });
        expect(capture.consoleEnabled("tab1")).toBe(false);
        expect(capture.networkEnabled("tab1")).toBe(false);

        fake.emit("cdp.event", consoleCall("after close"));
        expect(capture.readConsole("tab1", { limit: 10, order: "oldest", clear: false }).entries)
            .toEqual([]);

        await capture.ensureConsole("tab1");
        fake.emit("cdp.event", consoleCall("again"));
        capture.reset();
        expect(capture.consoleEnabled("tab1")).toBe(false);
        expect(capture.readConsole("tab1", { limit: 10, order: "oldest", clear: false }).entries)
            .toEqual([]);
    });

    it("reports dropped counts since the last read", async () => {
        const { fake, capture } = manager();

        await capture.ensureConsole("tab1");

        for (let index = 0; index < 1005; index += 1) {
            fake.emit("cdp.event", consoleCall(`message ${index}`));
        }

        const first = capture.readConsole("tab1", { limit: 1000, order: "oldest", clear: false });

        expect(first.entries).toHaveLength(1000);
        expect(first.droppedCount).toBe(5);
        expect(first.totalBuffered).toBe(1000);

        const second = capture.readConsole("tab1", {
            afterId: first.nextAfterId,
            limit  : 1000,
            order  : "oldest",
            clear  : false,
        });

        expect(second.entries).toEqual([]);
        expect(second.droppedCount).toBe(0);
    });
});
