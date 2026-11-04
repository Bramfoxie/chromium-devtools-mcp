import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { childEnvironment, findOnPath, runProgram, type RunResult } from "../../util/programs.js";

const ENCODE_TIMEOUT_MS = 120_000;

const SIZE_CAP_BYTES = 8 * 1024 * 1024 * 1024;

const COMMON = ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-i", "frames.txt"];

const EVEN_SIZE = "pad=ceil(iw/2)*2:ceil(ih/2)*2";

export interface VideoTools {
    find(): Promise<string | undefined>;
    run(
        program  : string,
        args     : string[],
        cwd      : string,
        timeoutMs: number,
        signal?  : AbortSignal,
    ): Promise<RunResult>;
    size(file: string): Promise<number>;
    remove(file: string): Promise<void>;
}

export interface Encoder {
    format: "mp4" | "webm";
    file  : string;
    args  : string[];
}

export const ENCODERS: readonly Encoder[] = [
    {
        format: "mp4",
        file  : "recording.mp4",
        args  : [
            ...COMMON,
            "-vf", EVEN_SIZE, "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", "-r", "30", "recording.mp4",
        ],
    },
    {
        format: "webm",
        file  : "recording.webm",
        args  : [
            ...COMMON,
            "-vf", EVEN_SIZE, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34",
            "-pix_fmt", "yuv420p", "-r", "30", "recording.webm",
        ],
    },
];

export interface EncodedVideo {
    format: "mp4" | "webm";
    file  : string;
    bytes : number;
}

export interface EncodeOutcome {
    video? : EncodedVideo;
    program: string | undefined;
    error? : string;
}

// ffmpeg is not shipped with this package: it is used when it is on the PATH of the server.
export async function encodeVideo(
    tools  : VideoTools,
    cwd    : string,
    signal?: AbortSignal,
): Promise<EncodeOutcome> {
    const program = await tools.find();

    if (program === undefined) return { program };

    let error = "";

    for (const encoder of ENCODERS) {
        const output = path.join(cwd, encoder.file);
        const outcome = await tools.run(program, encoder.args, cwd, ENCODE_TIMEOUT_MS, signal);

        if (outcome.ok) {
            const bytes = await tools.size(output).catch(() => -1);

            if (bytes > 0) {
                return { video: { format: encoder.format, file: encoder.file, bytes }, program };
            }

            error = `${encoder.format}: ffmpeg wrote no file`;
        } else {
            error = `${encoder.format}: ${outcome.error}`;
        }

        await tools.remove(output).catch(() => undefined);

        if (signal?.aborted === true) break;
    }

    return { program, error };
}

export function nodeVideoTools(
    env     : NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
): VideoTools {
    return {
        find: () => findOnPath(env, platform, "ffmpeg"),
        run : (program, args, cwd, timeoutMs, signal) =>
            runProgram(program, args, {
                cwd,
                timeoutMs,
                env: childEnvironment(env),
                ...(signal === undefined ? {} : { signal }),
            }),
        remove: (file) => rm(file, { force: true }),
        size  : async (file) => {
            const info = await stat(file);

            return Math.min(info.size, SIZE_CAP_BYTES);
        },
    };
}
