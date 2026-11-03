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

export function nodeVideoTools(
    env     : NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
): VideoTools {
    const p = pathFor(platform);

    return {
        find: async () => {
            const names = platform === "win32" ? ["ffmpeg.exe"] : ["ffmpeg"];
            const dirs = (env.PATH ?? env.Path ?? "").split(p.delimiter).filter((dir) => dir !== "");

            for (const dir of dirs) {
                if (!p.isAbsolute(dir)) continue;

                for (const name of names) {
                    const candidate = p.join(dir, name);

                    if (await executable(candidate)) return candidate;
                }
            }

            return undefined;
        },
        run: (program, args, cwd, timeoutMs) =>
            new Promise<RunResult>((resolve) => {
                let tail = "";
                let settled = false;
                const child = spawn(program, args, {
                    cwd,
                    shell      : false,
                    stdio      : ["ignore", "ignore", "pipe"],
                    windowsHide: true,
                });
                const finish = (result: RunResult): void => {
                    if (settled) return;

                    settled = true;
                    clearTimeout(timer);
                    resolve(result);
                };
                const timer = setTimeout(() => {
                    child.kill("SIGKILL");
                    finish({ ok: false, error: `ffmpeg did not finish within ${timeoutMs} ms` });
                }, timeoutMs);

                child.stderr.on("data", (chunk: Buffer) => {
                    tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
                });
                child.once("error", (error) => finish({ ok: false, error: error.message }));
                child.once("close", (code) =>
                    finish({ ok: code === 0, error: tail.trim() || `ffmpeg exited with code ${code}` }));
            }),
        size: async (file) => {
            const info = await stat(file);

            return Math.min(info.size, SIZE_CAP_BYTES);
        },
    };
}
