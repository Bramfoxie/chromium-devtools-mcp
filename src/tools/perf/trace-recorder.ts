import { z } from "zod";
import type { DaemonAccess } from "../../mcp/index.js";
import { parseEnvelope } from "../cdp-envelope.js";
import { ToolError } from "../errors.js";
import { startRendering } from "../hold-rendering.js";
import type { TraceEvent } from "./trace-filter.js";

const DATA_EVENT = "Tracing.dataCollected";

const COMPLETE_EVENT = "Tracing.tracingComplete";

const STOP_WAIT_MS = 30_000;

const MAX_EVENTS = 800_000;

const chunkSchema = z.object({ value: z.array(z.unknown()) });

interface Recording {
    events     : TraceEvent[];
    truncated  : boolean;
    startedAt  : number;
    complete   : Promise<void>;
    finish     : () => void;
    releaseHold: () => Promise<void>;
}

export interface RecordedTrace {
    events    : TraceEvent[];
    truncated : boolean;
    durationMs: number;
}

export interface TraceClock {
    now(): number;
    sleep(ms: number): Promise<void>;
}

function isEvent(value: unknown): value is TraceEvent {
    return typeof value === "object" && value !== null;
}

// Collects the browser wide trace events of the tab that started a recording.
export class TraceRecorder {
    private readonly recordings = new Map<string, Recording>();

    constructor(
        private readonly access: DaemonAccess,
        private readonly clock : TraceClock,
    ) {}

    attach(): void {
        this.access.on("cdp.event", (params) => this.handle(params));
    }

    recording(tab: string): boolean {
        return this.recordings.has(tab);
    }

    async start(tab: string): Promise<void> {
        if (this.recordings.has(tab)) {
            throw new ToolError("A trace is already recording on this tab. Stop it with perf_trace_stop first.");
        }

        let finish: () => void = () => undefined;
        const complete = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const releaseHold = await startRendering(this.access, tab);

        this.recordings.set(tab, {
            events   : [],
            truncated: false,
            startedAt: this.clock.now(),
            complete,
            finish,
            releaseHold,
        });

        try {
            await this.access.subscribe(tab, DATA_EVENT);
            await this.access.subscribe(tab, COMPLETE_EVENT);
            await this.access.send({ targetId: tab, method: "Tracing.start", params: {} });
        } catch (error) {
            await this.drop(tab);

            throw error;
        }
    }

    async stop(tab: string): Promise<RecordedTrace> {
        const recording = this.recordings.get(tab);

        if (recording === undefined) {
            throw new ToolError("No trace is recording on this tab. Start one with perf_trace_start.");
        }

        await this.access.send({ targetId: tab, method: "Tracing.end", params: {} });

        try {
            await this.waitFor(recording);

            return {
                events    : recording.events,
                truncated : recording.truncated,
                durationMs: this.clock.now() - recording.startedAt,
            };
        } finally {
            await this.drop(tab);
        }
    }

    async forget(tab: string): Promise<void> {
        await this.drop(tab, false);
    }

    async reset(): Promise<void> {
        await Promise.all([...this.recordings.keys()].map((tab) => this.drop(tab, false)));
    }

    private async waitFor(recording: Recording): Promise<void> {
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), STOP_WAIT_MS);
        });

        try {
            const outcome = await Promise.race([recording.complete.then(() => "done" as const), expired]);

            if (outcome === "timeout") {
                throw new ToolError("The browser did not finish the trace in time. Start a shorter one.");
            }
        } finally {
            clearTimeout(timer);
        }
    }

    private async drop(tab: string, unsubscribe = true): Promise<void> {
        const recording = this.recordings.get(tab);

        if (recording === undefined) return;

        this.recordings.delete(tab);
        recording.finish();

        if (unsubscribe) {
            await this.access.unsubscribe(tab, DATA_EVENT).catch(() => undefined);
            await this.access.unsubscribe(tab, COMPLETE_EVENT).catch(() => undefined);
        }

        await recording.releaseHold();
    }

    private handle(params: unknown): void {
        const envelope = parseEnvelope(params);

        if (envelope === undefined) return;

        const recording = this.recordings.get(envelope.targetId);

        if (recording === undefined) return;

        if (envelope.event === COMPLETE_EVENT) {
            recording.finish();

            return;
        }

        if (envelope.event !== DATA_EVENT) return;

        const chunk = chunkSchema.safeParse(envelope.params);

        if (!chunk.success) return;

        for (const entry of chunk.data.value) {
            if (recording.events.length >= MAX_EVENTS) {
                recording.truncated = true;

                return;
            }

            if (isEvent(entry)) recording.events.push(entry);
        }
    }
}
