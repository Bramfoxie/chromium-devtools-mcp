import { z } from "zod";
import type { DaemonAccess } from "../../mcp/index.js";
import { parseEnvelope } from "../cdp-envelope.js";
import { ToolError } from "../errors.js";
import { startRecording } from "../hold-rendering.js";

const FRAME_EVENT = "Page.screencastFrame";

const MAX_FRAMES = 3000;

const MAX_BYTES = 256 * 1024 * 1024;

const frameSchema = z.object({
    data     : z.string(),
    metadata : z.object({ timestamp: z.number().optional() }).optional(),
    sessionId: z.number(),
});

export type EndReason = "stopped" | "time" | "frames" | "size";

export interface ScreencastFrame {
    data     : Buffer;
    timestamp: number;
}

export interface ScreencastOptions {
    quality      : number;
    everyNthFrame: number;
    maxWidth     : number;
    maxDurationMs: number;
}

export interface RecordedScreencast {
    frames    : ScreencastFrame[];
    reason    : EndReason;
    durationMs: number;
}

interface Recording {
    options      : ScreencastOptions;
    frames       : ScreencastFrame[];
    bytes        : number;
    startedAt    : number;
    reason       : EndReason;
    active       : boolean;
    timer        : NodeJS.Timeout | undefined;
    finishCapture: () => Promise<void>;
}

export interface ScreencastClock {
    now(): number;
}

// Collects the frames of a tab while a screencast runs and acknowledges each one.
export class ScreencastRecorder {
    private readonly recordings = new Map<string, Recording>();

    constructor(
        private readonly access: DaemonAccess,
        private readonly clock : ScreencastClock,
    ) {}

    attach(): void {
        this.access.on("cdp.event", (params) => this.handle(params));
    }

    recording(tab: string): boolean {
        return this.recordings.has(tab);
    }

    async start(tab: string, options: ScreencastOptions): Promise<void> {
        if (this.recordings.has(tab)) {
            throw new ToolError(
                "A screencast is already recording on this tab. Stop it with screencast_stop first.",
            );
        }

        const recording: Recording = {
            options,
            frames       : [],
            bytes        : 0,
            startedAt    : this.clock.now(),
            reason       : "stopped",
            active       : true,
            timer        : undefined,
            finishCapture: async () => undefined,
        };

        this.recordings.set(tab, recording);

        try {
            await this.access.subscribe(tab, FRAME_EVENT);
            recording.finishCapture = await startRecording(this.access, tab, {
                format       : "jpeg",
                quality      : options.quality,
                maxWidth     : options.maxWidth,
                everyNthFrame: options.everyNthFrame,
            });
        } catch (error) {
            await this.drop(tab);

            throw error;
        }

        recording.timer = setTimeout(() => void this.end(tab, recording, "time"), options.maxDurationMs);
    }

    async stop(tab: string): Promise<RecordedScreencast> {
        const recording = this.recordings.get(tab);

        if (recording === undefined) {
            throw new ToolError("No screencast is recording on this tab. Start one with screencast_start.");
        }

        try {
            await this.end(tab, recording, "stopped");

            return {
                frames    : recording.frames,
                reason    : recording.reason,
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

    private async end(tab: string, recording: Recording, reason: EndReason): Promise<void> {
        if (!recording.active) return;

        recording.active = false;
        recording.reason = reason;
        clearTimeout(recording.timer);
        await recording.finishCapture();
    }

    private async drop(tab: string, unsubscribe = true): Promise<void> {
        const recording = this.recordings.get(tab);

        if (recording === undefined) return;

        this.recordings.delete(tab);
        recording.active = false;
        clearTimeout(recording.timer);

        if (unsubscribe) await this.access.unsubscribe(tab, FRAME_EVENT).catch(() => undefined);

        await recording.finishCapture();
    }

    private handle(params: unknown): void {
        const envelope = parseEnvelope(params);

        if (envelope?.event !== FRAME_EVENT) return;

        const recording = this.recordings.get(envelope.targetId);
        const frame = frameSchema.safeParse(envelope.params);

        if (recording === undefined || !frame.success) return;

        void this.access
            .send({
                targetId: envelope.targetId,
                method  : "Page.screencastFrameAck",
                params  : { sessionId: frame.data.sessionId },
            })
            .catch(() => undefined);

        if (!recording.active) return;

        const data = Buffer.from(frame.data.data, "base64");

        recording.frames.push({
            data,
            timestamp: frame.data.metadata?.timestamp ?? this.clock.now() / 1000,
        });
        recording.bytes += data.byteLength;

        if (recording.frames.length >= MAX_FRAMES) {
            void this.end(envelope.targetId, recording, "frames");
        } else if (recording.bytes >= MAX_BYTES) {
            void this.end(envelope.targetId, recording, "size");
        }
    }
}
