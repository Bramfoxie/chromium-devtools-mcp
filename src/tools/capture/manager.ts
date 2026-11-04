import { parseEnvelope } from "../cdp-envelope.js";
import type { DaemonAccess } from "../../mcp/index.js";
import type { ToolClock } from "../define-tool.js";
import {
    type ConsoleEntry,
    type ConsoleLevel,
    normalizeConsoleEvent,
} from "./console-log.js";
import {
    type NetworkFilter,
    type NetworkRecord,
    matchNetworkRecord,
    reduceNetworkEvent,
} from "./network-log.js";
import { RingBuffer } from "./ring-buffer.js";

const CONSOLE_BUFFER_ENTRIES = 1000;

const CONSOLE_BUFFER_BYTES = 2 * 1024 * 1024;

const NETWORK_BUFFER_ENTRIES = 2000;

const NETWORK_BUFFER_BYTES = 8 * 1024 * 1024;

const CONSOLE_EVENTS = [
    "Runtime.consoleAPICalled",
    "Runtime.exceptionThrown",
    "Log.entryAdded",
] as const;

const NETWORK_EVENTS = [
    "Network.requestWillBeSent",
    "Network.responseReceived",
    "Network.loadingFinished",
    "Network.loadingFailed",
    "Network.requestServedFromCache",
    "Network.webSocketCreated",
] as const;

interface TabCapture {
    consoleEnabled: boolean;
    networkEnabled: boolean;
    console       : RingBuffer<ConsoleEntry>;
    network       : RingBuffer<NetworkRecord>;
    requests      : Map<string, { id: number; record: NetworkRecord }>;
    consoleDropped: number;
    networkDropped: number;
}

interface ConsoleQuery {
    levels?      : ConsoleLevel[];
    textContains?: string;
    afterId?     : number;
    limit        : number;
    order        : "oldest" | "newest";
    clear        : boolean;
}

interface NetworkQuery {
    filter : NetworkFilter;
    afterId: number | undefined;
    limit  : number;
    clear  : boolean;
}

interface CaptureManagerOptions {
    access: DaemonAccess;
    clock : ToolClock;
}

function entryBytes(entry: ConsoleEntry): number {
    return Buffer.byteLength(JSON.stringify(entry));
}

function recordBytes(record: NetworkRecord): number {
    return Buffer.byteLength(JSON.stringify(record));
}

export class CaptureManager {
    private readonly access: DaemonAccess;
    private readonly clock : ToolClock;
    private readonly tabs = new Map<string, TabCapture>();
    private attached = false;

    constructor(options: CaptureManagerOptions) {
        this.access = options.access;
        this.clock = options.clock;
    }

    attach(): void {
        if (this.attached) return;

        this.attached = true;
        this.access.on("cdp.event", (params) => this.handleCdpEvent(params));
    }

    consoleEnabled(tab: string): boolean {
        return this.tabs.get(tab)?.consoleEnabled ?? false;
    }

    networkEnabled(tab: string): boolean {
        return this.tabs.get(tab)?.networkEnabled ?? false;
    }

    async ensureConsole(tab: string): Promise<void> {
        const capture = this.capture(tab);

        if (capture.consoleEnabled) return;

        for (const event of CONSOLE_EVENTS) await this.access.subscribe(tab, event);

        try {
            await this.access.send({
                targetId: tab,
                method  : "Runtime.enable",
                params  : {},
            });
            await this.access.send({
                targetId: tab,
                method  : "Log.enable",
                params  : {},
            });
        } catch (error) {
            for (const event of CONSOLE_EVENTS) {
                await this.access.unsubscribe(tab, event).catch(() => undefined);
            }

            throw error;
        }

        capture.consoleEnabled = true;
    }

    async ensureNetwork(tab: string): Promise<void> {
        const capture = this.capture(tab);

        if (capture.networkEnabled) return;

        for (const event of NETWORK_EVENTS) await this.access.subscribe(tab, event);

        try {
            await this.access.send({
                targetId: tab,
                method  : "Network.enable",
                params  : {},
            });
        } catch (error) {
            for (const event of NETWORK_EVENTS) {
                await this.access.unsubscribe(tab, event).catch(() => undefined);
            }

            throw error;
        }

        capture.networkEnabled = true;
    }

    handleCdpEvent(params: unknown): void {
        const envelope = parseEnvelope(params);

        if (envelope === undefined) return;

        const capture = this.tabs.get(envelope.targetId);

        if (capture === undefined) return;

        const consoleEntry = normalizeConsoleEvent(
            envelope.event,
            envelope.params,
            new Date(this.clock.now()).toISOString(),
        );

        if (consoleEntry !== undefined) {
            capture.console.push(consoleEntry);

            return;
        }

        this.handleNetworkEvent(capture, envelope.event, envelope.params);
    }

    private handleNetworkEvent(capture: TabCapture, event: string, params: unknown): void {
        const paramsRecord = params as { requestId?: unknown } | null;
        const requestId = typeof paramsRecord?.requestId === "string"
            ? paramsRecord.requestId
            : undefined;
        const known = requestId === undefined ? undefined : capture.requests.get(requestId);
        const before = known === undefined ? undefined : recordBytes(known.record);
        const reduced = reduceNetworkEvent(event, params, (id) => capture.requests.get(id)?.record);

        if (reduced === undefined) return;

        if (
            reduced.record.finished && reduced.record.finishedAt === undefined &&
            (event === "Network.loadingFinished" || event === "Network.loadingFailed")
        ) {
            reduced.record.finishedAt = this.clock.now();
        }

        if (reduced.created) {
            if (reduced.redirected && known !== undefined && before !== undefined) {
                reduced.record.redirectedFrom = known.id;
                capture.network.adjust(known.id, recordBytes(known.record) - before);
            }

            const id = capture.network.push(reduced.record);

            capture.requests.set(reduced.record.requestId, { id, record: reduced.record });

            return;
        }

        if (known !== undefined && before !== undefined) {
            capture.network.adjust(known.id, recordBytes(known.record) - before);
        }
    }

    readConsole(tab: string, query: ConsoleQuery): {
        entries      : Array<{ id: number; entry: ConsoleEntry }>;
        nextAfterId  : number;
        droppedCount : number;
        totalBuffered: number;
    } {
        const capture = this.capture(tab);
        const droppedCount = capture.console.dropped - capture.consoleDropped;

        capture.consoleDropped = capture.console.dropped;

        const afterId = query.afterId ?? 0;
        const filtered = capture.console
            .after(afterId, Number.MAX_SAFE_INTEGER)
            .filter(({ value }) =>
                (query.levels === undefined || query.levels.includes(value.level)) &&
                (query.textContains === undefined || value.text.includes(query.textContains)),
            );
        const kept = query.order === "newest"
            ? filtered.slice(-query.limit)
            : filtered.slice(0, query.limit);
        const entries = kept.map(({ id, value }) => ({ id, entry: value }));
        const ordered = query.order === "newest" ? [...entries].reverse() : entries;
        const nextAfterId = entries.length === 0
            ? afterId
            : Math.max(...entries.map(({ id }) => id));
        const totalBuffered = capture.console.size;

        if (query.clear) {
            capture.console.clear();
            capture.consoleDropped = 0;
        }

        return { entries: ordered, nextAfterId, droppedCount, totalBuffered };
    }

    readNetwork(tab: string, query: NetworkQuery): {
        records      : Array<{ id: number; record: NetworkRecord }>;
        nextAfterId  : number;
        droppedCount : number;
        totalBuffered: number;
    } {
        const capture = this.capture(tab);
        const droppedCount = capture.network.dropped - capture.networkDropped;

        capture.networkDropped = capture.network.dropped;

        const afterId = query.afterId ?? 0;
        const records = capture.network
            .after(afterId, Number.MAX_SAFE_INTEGER)
            .filter(({ value }) => matchNetworkRecord(value, query.filter))
            .slice(0, query.limit)
            .map(({ id, value }) => ({ id, record: value }));
        const nextAfterId = records.length === 0
            ? afterId
            : Math.max(...records.map(({ id }) => id));
        const totalBuffered = capture.network.size;

        if (query.clear) {
            capture.network.clear();
            capture.requests.clear();
            capture.networkDropped = 0;
        }

        return { records, nextAfterId, droppedCount, totalBuffered };
    }

    idleNetworkMs(tab: string, since?: number): number {
        const capture = this.tabs.get(tab);

        if (capture === undefined) return Number.MAX_SAFE_INTEGER;

        let latest: number | undefined;
        let seen = false;

        for (const { value } of capture.network.after(0, Number.MAX_SAFE_INTEGER)) {
            if (value.finished) {
                const fresh = value.finishedAt !== undefined &&
                    (since === undefined || value.finishedAt >= since);

                if (fresh && value.finishedAt !== undefined) {
                    seen = true;
                    latest = latest === undefined
                        ? value.finishedAt
                        : Math.max(latest, value.finishedAt);
                }

                continue;
            }

            if (value.requestId.includes(".") || since === undefined) return 0;

            if (value.startTime === undefined && value.finishedAt === undefined) continue;

            seen = true;
        }

        if (!seen) return Number.MAX_SAFE_INTEGER;
        if (latest === undefined) return 0;

        return Math.max(0, this.clock.now() - latest);
    }

    networkRecord(tab: string, id: number): { id: number; record: NetworkRecord } | undefined {
        const record = this.tabs.get(tab)?.network.get(id);

        if (record === undefined) return undefined;

        return { id, record };
    }

    forget(tab: string): void {
        this.tabs.delete(tab);
    }

    reset(): void {
        this.tabs.clear();
    }

    private capture(tab: string): TabCapture {
        let capture = this.tabs.get(tab);

        if (!capture) {
            const requests = new Map<string, { id: number; record: NetworkRecord }>();

            capture = {
                consoleEnabled: false,
                networkEnabled: false,
                console       : new RingBuffer<ConsoleEntry>({
                    maxEntries: CONSOLE_BUFFER_ENTRIES,
                    maxBytes  : CONSOLE_BUFFER_BYTES,
                    sizeOf    : entryBytes,
                }),
                network: new RingBuffer<NetworkRecord>({
                    maxEntries: NETWORK_BUFFER_ENTRIES,
                    maxBytes  : NETWORK_BUFFER_BYTES,
                    sizeOf    : recordBytes,
                    onEvict   : (_id, record) => {
                        if (requests.get(record.requestId)?.record === record) {
                            requests.delete(record.requestId);
                        }
                    },
                }),
                requests,
                consoleDropped: 0,
                networkDropped: 0,
            };
            this.tabs.set(tab, capture);
        }

        return capture;
    }
}
