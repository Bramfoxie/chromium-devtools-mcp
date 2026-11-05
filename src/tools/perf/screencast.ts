import path from "node:path";
import { z } from "zod";
import { defineTool } from "../define-tool.js";
import { ensureNoDialog } from "../dialogs.js";
import { ToolError } from "../errors.js";
import { throwIfCancelled } from "../registry.js";
import { resolveTab, tabSchema } from "../tab-target.js";
import type { EndReason, ScreencastFrame } from "./screencast-recorder.js";
import { encodeVideo } from "./video.js";

const FPS_DEFAULT = 10;

const QUALITY_DEFAULT = 60;

const WIDTH_DEFAULT = 1280;

const DURATION_DEFAULT_MS = 30_000;

const DURATION_MAX_MS = 120_000;

const SCREEN_FPS = 60;

const LAST_FRAME_SECONDS = 0.5;

const MIN_FRAME_SECONDS = 0.001;

const REASON_TEXT: Record<EndReason, string | undefined> = {
    stopped: undefined,
    time   : "The recording stopped at its time limit.",
    frames : "The recording stopped because it reached the limit of 3000 frames.",
    size   : "The recording stopped because it reached the limit of 256 MiB.",
};

function frameName(index: number): string {
    return `frame-${String(index + 1).padStart(5, "0")}.jpg`;
}

function concatList(frames: ScreencastFrame[]): string {
    const lines: string[] = [];

    frames.forEach((frame, index) => {
        const next = frames[index + 1];
        const seconds = next === undefined
            ? LAST_FRAME_SECONDS
            : Math.max(MIN_FRAME_SECONDS, next.timestamp - frame.timestamp);

        lines.push(`file '${frameName(index)}'`, `duration ${seconds.toFixed(3)}`);
    });

    const last = frames.length - 1;

    lines.push(`file '${frameName(last)}'`);

    return `${lines.join("\n")}\n`;
}

export const screencastStart = defineTool({
    name       : "screencast_start",
    untrusted  : false,
    closedWorld: true,
    description:
        "Start recording what a tab shows as a series of frames. The tab keeps rendering in the background, no window is raised. Call screencast_stop to get the recording. A static page produces few frames because a frame is made only when the page changes.",
    access: "read",
    input : z.strictObject({
        tab          : tabSchema,
        fps          : z.number().int().min(1).max(30).optional().describe(`Frames per second at most, 1 to 30. Defaults to ${FPS_DEFAULT}.`),
        quality      : z.number().int().min(1).max(100).optional().describe(`JPEG quality of the frames, 1 to 100. Defaults to ${QUALITY_DEFAULT}.`),
        maxWidth     : z.number().int().min(100).max(3840).optional().describe(`Widest frame in pixels, larger pages are scaled down. Defaults to ${WIDTH_DEFAULT}.`),
        maxDurationMs: z.number().int().min(1000).max(DURATION_MAX_MS).optional().describe(`Stop recording after this many milliseconds, 1000 to ${DURATION_MAX_MS}. Defaults to ${DURATION_DEFAULT_MS}.`),
    }),
    output: z.strictObject({
        tab          : z.string().describe("Tab id."),
        recording    : z.boolean().describe("Whether the screencast is recording."),
        fps          : z.number().describe("Frames per second at most."),
        maxDurationMs: z.number().describe("Time after which the recording stops by itself."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);
        const fps = args.fps ?? FPS_DEFAULT;
        const maxDurationMs = args.maxDurationMs ?? DURATION_DEFAULT_MS;

        throwIfCancelled(context.signal);
        await ensureNoDialog(context.dialogs, targetId);
        await context.focus.ensure(context.access, targetId);
        await context.screencast.start(targetId, {
            quality      : args.quality ?? QUALITY_DEFAULT,
            everyNthFrame: Math.max(1, Math.round(SCREEN_FPS / fps)),
            maxWidth     : args.maxWidth ?? WIDTH_DEFAULT,
            maxDurationMs,
        });

        return { tab: targetId, recording: true, fps, maxDurationMs };
    },
});

export const screencastStop = defineTool({
    name       : "screencast_stop",
    closedWorld: true,
    description:
        "Stop the screencast of a tab and save it. With ffmpeg on the PATH of the server the result is an MP4 file, or WebM when the MP4 encoder is missing; without ffmpeg the frames are saved as JPEG files in a directory with their durations, and the result says how to get a video.",
    access: "read",
    input : z.strictObject({ tab: tabSchema }),
    output: z.strictObject({
        tab       : z.string().describe("Tab id."),
        format    : z.enum(["mp4", "webm", "frames"]).describe("mp4 or webm is one video file, frames is a directory of JPEG files."),
        path      : z.string().describe("Absolute path of the video file, or of the directory of frames."),
        bytes     : z.number().describe("Size of the video file, or of all frames."),
        frames    : z.number().describe("Frames that were recorded."),
        durationMs: z.number().describe("Length of the recording in milliseconds."),
        note      : z.string().optional().describe("Why the recording ended early, or why there is no video."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        throwIfCancelled(context.signal);

        const recorded = await context.screencast.stop(targetId);

        if (recorded.frames.length === 0) {
            throw new ToolError(
                "No frame was recorded. A page makes a frame only when it changes, so interact with it or reload it while the screencast runs.",
            );
        }

        const dir = await context.artifacts.directory("screencast");
        let frameBytes = 0;

        for (const [index, frame] of recorded.frames.entries()) {
            frameBytes += await dir.write(frameName(index), frame.data);
        }

        await dir.write("frames.txt", concatList(recorded.frames));

        const encoded = await encodeVideo(context.video, dir.path, context.signal);
        const early = REASON_TEXT[recorded.reason];
        const base = {
            tab       : targetId,
            frames    : recorded.frames.length,
            durationMs: recorded.durationMs,
        };

        if (encoded.video !== undefined) {
            for (const [index] of recorded.frames.entries()) await dir.remove(frameName(index));

            await dir.remove("frames.txt");

            return {
                ...base,
                format: encoded.video.format,
                path  : path.join(dir.path, encoded.video.file),
                bytes : encoded.video.bytes,
                ...(early === undefined ? {} : { note: early }),
            };
        }

        const why = encoded.program === undefined
            ? "ffmpeg was not found on the PATH of the server, so the frames were saved as JPEG files with their durations in frames.txt. Install ffmpeg to get a video."
            : `ffmpeg could not encode the frames (${encoded.error ?? "unknown error"}), so they were saved as JPEG files with their durations in frames.txt.`;

        return {
            ...base,
            format: "frames" as const,
            path  : dir.path,
            bytes : frameBytes,
            note  : early === undefined ? why : `${early} ${why}`,
        };
    },
});
