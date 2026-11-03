import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { pathFor } from "../../config/index.js";

const ENCODE_TIMEOUT_MS = 120_000;

const STDERR_TAIL_CHARS = 600;

const SIZE_CAP_BYTES = 8 * 1024 * 1024 * 1024;

const COMMON = ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-i", "frames.txt"];

const EVEN_SIZE = "pad=ceil(iw/2)*2:ceil(ih/2)*2";

export interface RunResult {
    ok   : boolean;
    error: string;
}

export interface VideoTools {
    find(): Promise<string | undefined>;
    run(program: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult>;
    size(file: string): Promise<number>;
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
export async function encodeVideo(tools: VideoTools, cwd: string): Promise<EncodeOutcome> {
    const program = await tools.find();

    if (program === undefined) return { program };

    let error = "";

    for (const encoder of ENCODERS) {
        const outcome = await tools.run(program, encoder.args, cwd, ENCODE_TIMEOUT_MS);

        if (outcome.ok) {
            const bytes = await tools.size(path.join(cwd, encoder.file)).catch(() => -1);

            if (bytes > 0) {
                return { video: { format: encoder.format, file: encoder.file, bytes }, program };
            }

            error = `${encoder.format}: ffmpeg wrote no file`;
        } else {
            error = `${encoder.format}: ${outcome.error}`;
        }
    }

    return { program, error };
}

async function executable(file: string): Promise<boolean> {
    try {
        const info = await stat(file);

        if (!info.isFile()) return false;

        await access(file, 1);

        return true;
    } catch {
        return false;
    }
}

export async function findOnPath(
    env     : NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
    name    : string,
): Promise<string | undefined> {
    const p = pathFor(platform);
    const names = platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
    const dirs = (env.PATH ?? env.Path ?? "").split(p.delimiter).filter((dir) => dir !== "");

    for (const dir of dirs) {
        if (!p.isAbsolute(dir)) continue;

        for (const candidate of names) {
            const file = p.join(dir, candidate);

            if (await executable(file)) return file;
        }
    }

    return undefined;
}

export interface RunOptions {
    cwd      : string;
    timeoutMs: number;
    env?     : NodeJS.ProcessEnv;
    signal?  : AbortSignal;
}

// Runs a program without a shell; the arguments are never joined into a command line.
export function runProgram(
    program: string,
    args   : string[],
    options: RunOptions,
): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
        let tail = "";
        let settled = false;
        const child = spawn(program, args, {
            cwd        : options.cwd,
            env        : options.env,
            shell      : false,
            stdio      : ["ignore", "ignore", "pipe"],
            windowsHide: true,
        });
        const finish = (result: RunResult): void => {
            if (settled) return;

            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            resolve(result);
        };
        const onAbort = (): void => {
            child.kill("SIGKILL");
            finish({ ok: false, error: "the call was cancelled" });
        };
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish({ ok: false, error: `${path.basename(program)} did not finish within ${options.timeoutMs} ms` });
        }, options.timeoutMs);

        options.signal?.addEventListener("abort", onAbort, { once: true });
        child.stderr.on("data", (chunk: Buffer) => {
            tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
        });
        child.once("error", (error) => finish({ ok: false, error: error.message }));
        child.once("close", (code) =>
            finish({ ok: code === 0, error: tail.trim() || `${path.basename(program)} exited with code ${code}` }));
    });
}

export function nodeVideoTools(
    env     : NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
): VideoTools {
    return {
        find: () => findOnPath(env, platform, "ffmpeg"),
        run : (program, args, cwd, timeoutMs) => runProgram(program, args, { cwd, timeoutMs }),
        size: async (file) => {
            const info = await stat(file);

            return Math.min(info.size, SIZE_CAP_BYTES);
        },
    };
}
