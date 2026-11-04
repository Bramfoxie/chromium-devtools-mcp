import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENCODERS, encodeVideo, nodeVideoTools, type VideoTools } from "../src/tools/perf/video.js";

function tools(overrides: Partial<VideoTools> = {}) {
    const runs: Array<{ program: string; args: string[]; cwd: string }> = [];
    const value: VideoTools = {
        find: async () => "/usr/bin/ffmpeg",
        run : async (program, args, cwd) => {
            runs.push({ program, args, cwd });

            return { ok: true, error: "" };
        },
        size  : async () => 1234,
        remove: async () => undefined,
        ...overrides,
    };

    return { value, runs };
}

describe("encodeVideo", () => {
    it("encodes an mp4 with fixed arguments in the directory of the frames", async () => {
        const { value, runs } = tools();
        const outcome = await encodeVideo(value, "/data/artifacts/screencast-1");

        expect(outcome.video).toEqual({ format: "mp4", file: "recording.mp4", bytes: 1234 });
        expect(runs).toHaveLength(1);
        expect(runs[0]?.program).toBe("/usr/bin/ffmpeg");
        expect(runs[0]?.cwd).toBe("/data/artifacts/screencast-1");
        expect(runs[0]?.args).toEqual(ENCODERS[0]?.args);
        expect(runs[0]?.args).toEqual(expect.arrayContaining(["-f", "concat", "-i", "frames.txt", "libx264"]));
        expect(runs[0]?.args.at(-1)).toBe("recording.mp4");
    });

    it("falls back to webm when the mp4 encoder fails", async () => {
        const attempts: string[] = [];
        const { value } = tools({
            run: async (_program, args) => {
                attempts.push(args.at(-1) ?? "");

                return args.at(-1) === "recording.mp4"
                    ? { ok: false, error: "Unknown encoder 'libx264'" }
                    : { ok: true, error: "" };
            },
        });
        const outcome = await encodeVideo(value, "/dir");

        expect(attempts).toEqual(["recording.mp4", "recording.webm"]);
        expect(outcome.video?.format).toBe("webm");
    });

    it("reports the last error when no encoder works", async () => {
        const { value } = tools({
            run: async (_program, args) => ({ ok: false, error: `failed ${args.at(-1)}` }),
        });
        const outcome = await encodeVideo(value, "/dir");

        expect(outcome.video).toBeUndefined();
        expect(outcome.program).toBe("/usr/bin/ffmpeg");
        expect(outcome.error).toBe("webm: failed recording.webm");
    });

    it("treats an empty or missing output file as a failure", async () => {
        const { value } = tools({
            size: async () => {
                throw new Error("ENOENT");
            },
        });
        const outcome = await encodeVideo(value, "/dir");

        expect(outcome.video).toBeUndefined();
        expect(outcome.error).toBe("webm: ffmpeg wrote no file");
    });

    it("runs nothing when ffmpeg is not found", async () => {
        const { value, runs } = tools({ find: async () => undefined });
        const outcome = await encodeVideo(value, "/dir");

        expect(outcome).toEqual({ program: undefined });
        expect(runs).toEqual([]);
    });

    it("gives each encoder a distinct output file and no user supplied text", () => {
        expect(ENCODERS.map((encoder) => encoder.file)).toEqual(["recording.mp4", "recording.webm"]);

        for (const encoder of ENCODERS) {
            expect(encoder.args.every((arg) => !/[;&|`$]/.test(arg.replace("ceil(iw/2)*2:ceil(ih/2)*2", "")))).toBe(
                true,
            );
        }
    });
});

describe.skipIf(process.platform === "win32")("nodeVideoTools on a real directory", () => {
    let dir: string | undefined;

    afterEach(async () => {
        if (dir !== undefined) await rm(dir, { recursive: true, force: true });

        dir = undefined;
    });

    async function fakeFfmpeg(body: string): Promise<string> {
        dir = await mkdtemp(path.join(os.tmpdir(), "cdm-ffmpeg-"));
        const file = path.join(dir, "ffmpeg");

        await writeFile(file, `#!/bin/sh\n${body}\n`);
        await chmod(file, 0o755);

        return file;
    }

    it("finds an executable ffmpeg on the PATH and skips relative entries and plain files", async () => {
        const file = await fakeFfmpeg("exit 0");
        const empty = await mkdtemp(path.join(os.tmpdir(), "cdm-empty-"));
        const found = await nodeVideoTools(
            { PATH: ["relative/dir", empty, path.dirname(file)].join(path.delimiter) },
            process.platform,
        ).find();

        await rm(empty, { recursive: true, force: true });

        expect(found).toBe(file);
        expect(await nodeVideoTools({ PATH: "" }, process.platform).find()).toBeUndefined();
        expect(await nodeVideoTools({}, process.platform).find()).toBeUndefined();
    });

    it("does not take a file without the execute bit", async () => {
        const file = await fakeFfmpeg("exit 0");

        await chmod(file, 0o644);

        const found = await nodeVideoTools({ PATH: path.dirname(file) }, process.platform).find();

        expect(found).toBeUndefined();
    });

    it("runs the program without a shell and reports success and failure with its message", async () => {
        const file = await fakeFfmpeg('echo "boom: $1" >&2; [ "$1" = ok ] && exit 0; exit 3');
        const real = nodeVideoTools({}, process.platform);

        expect(await real.run(file, ["ok"], os.tmpdir(), 5000)).toMatchObject({ ok: true });
        expect(await real.run(file, ["; touch pwned"], os.tmpdir(), 5000)).toEqual({
            ok   : false,
            error: "boom: ; touch pwned",
        });
    });

    it("reports a program that does not start and one that runs too long", async () => {
        const slow = await fakeFfmpeg("sleep 5");
        const real = nodeVideoTools({}, process.platform);

        expect((await real.run("/definitely/not/here", [], os.tmpdir(), 5000)).ok).toBe(false);

        const outcome = await real.run(slow, [], os.tmpdir(), 200);

        expect(outcome.ok).toBe(false);
        expect(outcome.error).toContain("did not finish within 200 ms");
    });

    it("measures the size of a file", async () => {
        const file = await fakeFfmpeg("exit 0");

        expect(await nodeVideoTools({}, process.platform).size(file)).toBeGreaterThan(0);
    });
});
