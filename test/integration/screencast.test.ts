import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeVideoTools } from "../../src/tools/index.js";
import { chromeAvailable, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
const ffmpeg = await nodeVideoTools(process.env, process.platform).find();
let withVideo: Env;
let without: Env;

const PAGE = `<!doctype html><title>Anim</title><body style="margin:0">
<div id="box" style="width:300px;height:200px">tick</div>
<script>
  let n = 0;
  setInterval(() => {
    n += 1;
    const box = document.getElementById("box");
    box.style.background = "hsl(" + ((n * 37) % 360) + " 70% 50%)";
    box.textContent = "tick " + n;
  }, 60);
</script></body>`;

beforeAll(async () => {
    if (!present) return;

    withVideo = await startEnv();
    without = await startEnv(undefined, false, nodeVideoTools({ PATH: "" }, process.platform));

    for (const env of [withVideo, without]) {
        env.fixture.pages.set("/anim", { body: PAGE, status: 200, type: "text/html" });
    }
});

afterAll(async () => {
    await withVideo?.stop();
    await without?.stop();
});

type Stopped = {
    format    : "mp4" | "webm" | "frames";
    path      : string;
    bytes     : number;
    frames    : number;
    durationMs: number;
    note?     : string;
};

async function record(env: Env): Promise<Stopped> {
    const tab = await env.open("/anim");

    await env.ok("screencast_start", { tab, fps: 15 });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    return (await env.ok("screencast_stop", { tab })) as unknown as Stopped;
}

describe.skipIf(!present)("screencast in a real browser", () => {
    it.skipIf(ffmpeg === undefined)("saves a video of a background tab when ffmpeg is installed", async () => {
        const result = await record(withVideo);

        expect(["mp4", "webm"]).toContain(result.format);
        expect(result.frames).toBeGreaterThan(1);
        expect(result.path.startsWith(withVideo.artifactsDir)).toBe(true);
        expect(result.path.endsWith(`.${result.format}`)).toBe(true);
        expect((await stat(result.path)).size).toBe(result.bytes);

        const head = await readFile(result.path);

        if (result.format === "mp4") expect(head.subarray(4, 8).toString("latin1")).toBe("ftyp");

        expect(await readdir(path.dirname(result.path))).toEqual([path.basename(result.path)]);
    });

    it("saves the frames with their durations when ffmpeg is not found", async () => {
        const result = await record(without);

        expect(result.format).toBe("frames");
        expect(result.note).toContain("ffmpeg was not found");
        expect(result.frames).toBeGreaterThan(1);

        const files = await readdir(result.path);
        const jpegs = files.filter((name) => name.endsWith(".jpg"));

        expect(jpegs).toHaveLength(result.frames);
        expect(files).toContain("frames.txt");

        const first = await readFile(path.join(result.path, jpegs[0] ?? ""));

        expect(first.subarray(0, 2).toString("hex")).toBe("ffd8");
        expect(await readFile(path.join(result.path, "frames.txt"), "utf8")).toMatch(/duration \d+\.\d{3}/);
    });

    it("refuses a second recording on the tab and a stop without a start", async () => {
        const tab = await without.open("/anim");

        await without.ok("screencast_start", { tab });
        const again = await without.call("screencast_start", { tab });

        expect(again.isError).toBe(true);
        expect(again.text).toContain("already recording");

        await new Promise((resolve) => setTimeout(resolve, 1500));
        await without.ok("screencast_stop", { tab });
        const none = await without.call("screencast_stop", { tab });

        expect(none.isError).toBe(true);
        expect(none.text).toContain("screencast_start");
    });

    it("reports a recording that ended at its time limit", async () => {
        const tab = await without.open("/anim");

        await without.ok("screencast_start", { tab, maxDurationMs: 1000 });
        await new Promise((resolve) => setTimeout(resolve, 1600));
        const result = (await without.ok("screencast_stop", { tab })) as unknown as Stopped;

        expect(result.note).toContain("time limit");
        expect(result.frames).toBeGreaterThan(0);
    });

    it("reports no frame for a page that does not change", async () => {
        without.fixture.pages.set("/still", {
            body  : "<!doctype html><p>still</p>",
            status: 200,
            type  : "text/html",
        });
        const tab = await without.open("/still");

        await new Promise((resolve) => setTimeout(resolve, 600));
        await without.ok("screencast_start", { tab });
        await new Promise((resolve) => setTimeout(resolve, 600));
        const result = await without.call("screencast_stop", { tab });

        expect(result.isError).toBe(true);
        expect(result.text).toContain("No frame was recorded");
    });
});
