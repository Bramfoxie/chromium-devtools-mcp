import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    type ArtifactStore,
    runTool,
    screencastStart,
    screencastStop,
    ToolRuntime,
    type VideoTools,
} from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const DIR = "/data/artifacts/screencast-20261103T123456-0123456789ab";

function setup(video: Partial<VideoTools> = {}) {
    const fake = new FakeAccess({
        tabs: [{ targetId: "tab1", url: "https://a.example/", title: "t", owned: true, created: true }],
    });
    const files = new Map<string, string | Uint8Array>();
    const removed: string[] = [];
    const artifacts: ArtifactStore = {
        write    : () => Promise.reject(new Error("not used")),
        directory: async () => ({
            path : DIR,
            write: async (name, data) => {
                files.set(name, data);

                return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
            },
            remove: async (name) => {
                removed.push(name);
                files.delete(name);
            },
        }),
    };
    const tools: VideoTools = {
        find  : async () => undefined,
        run   : async () => ({ ok: true, error: "" }),
        size  : async () => 4096,
        remove: async () => undefined,
        ...video,
    };
    const runtime = new ToolRuntime({
        access: fake.asAccess(),
        config: managedConfig,
        artifacts,
        video : tools,
    });

    runtime.attach();
    runtime.tabs.select("tab1");

    return { fake, runtime, files, removed };
}

function frame(fake: FakeAccess, index: number, timestamp = 100 + index * 0.1, tab = "tab1"): void {
    fake.emit("cdp.event", {
        targetId: tab,
        event   : "Page.screencastFrame",
        params  : {
            data     : Buffer.from(`jpeg-${index}`).toString("base64"),
            metadata : { timestamp },
            sessionId: index + 1,
        },
    });
}

const methods = (fake: FakeAccess) => fake.sent.map((call) => call.method);

const text = (result: { content: unknown }) => JSON.stringify(result.content);

describe("screencast_start", () => {
    it("keeps the tab rendering, takes over the screencast and subscribes to the frames", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(
            screencastStart,
            { fps: 15, quality: 70, maxWidth: 800, maxDurationMs: 5000 },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toEqual({
            tab          : "tab1",
            recording    : true,
            fps          : 15,
            maxDurationMs: 5000,
        });
        expect(methods(fake)).toEqual([
            "Page.enable",
            "Emulation.setFocusEmulationEnabled",
            "Page.startScreencast",
        ]);
        expect(fake.sent.at(-1)?.params).toEqual({
            format       : "jpeg",
            quality      : 70,
            maxWidth     : 800,
            everyNthFrame: 4,
        });
        expect(fake.subscribed.map((entry) => entry.event)).toContain("Page.screencastFrame");
    });

    it("uses defaults of 10 frames per second, quality 60 and width 1280", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(screencastStart, {}, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ fps: 10, maxDurationMs: 30_000 });
        expect(fake.sent.at(-1)?.params).toEqual({
            format       : "jpeg",
            quality      : 60,
            maxWidth     : 1280,
            everyNthFrame: 6,
        });
    });

    it("refuses a second recording on the tab and lets go when the browser refuses the start", async () => {
        const { fake, runtime } = setup();

        await runTool(screencastStart, {}, extra(), runtime);
        const again = await runTool(screencastStart, {}, extra(), runtime);

        expect(again.isError).toBe(true);
        expect(text(again)).toContain("already recording");

        const other = setup();

        other.fake.failSend = (_tab, method) =>
            method === "Page.startScreencast" ? new Error("no screencast") : undefined;

        const refused = await runTool(screencastStart, {}, extra(), other.runtime);

        expect(refused.isError).toBe(true);
        expect(other.runtime.screencast.recording("tab1")).toBe(false);
        expect(other.fake.unsubscribed.map((entry) => entry.event)).toContain("Page.screencastFrame");
        expect(fake.sent.length).toBeGreaterThan(0);
    });

    it("limits its inputs", () => {
        const accepts = (value: unknown) => screencastStart.input.safeParse(value).success;

        const largest = { fps: 30, quality: 100, maxWidth: 3840, maxDurationMs: 120_000 };

        expect(accepts(largest)).toBe(true);
        expect(accepts({ fps: 0 })).toBe(false);
        expect(accepts({ fps: 31 })).toBe(false);
        expect(accepts({ quality: 0 })).toBe(false);
        expect(accepts({ maxWidth: 99 })).toBe(false);
        expect(accepts({ maxDurationMs: 999 })).toBe(false);
        expect(accepts({ maxDurationMs: 120_001 })).toBe(false);
    });
});

describe("recording frames", () => {
    it("acknowledges every frame and ignores the frames of other tabs", async () => {
        const { fake, runtime } = setup();

        await runTool(screencastStart, {}, extra(), runtime);
        frame(fake, 0);
        frame(fake, 1);
        frame(fake, 2, 100.2, "tab2");
        await new Promise((resolve) => setImmediate(resolve));

        const acks = fake.sent.filter((call) => call.method === "Page.screencastFrameAck");

        expect(acks.map((call) => call.params)).toEqual([{ sessionId: 1 }, { sessionId: 2 }]);
        await runTool(screencastStop, {}, extra(), runtime);
    });

    it("stops by itself at the time limit and keeps the frames", async () => {
        vi.useFakeTimers();
        const { fake, runtime } = setup();

        await runTool(screencastStart, { maxDurationMs: 1000 }, extra(), runtime);
        frame(fake, 0);
        await vi.advanceTimersByTimeAsync(1100);
        frame(fake, 1);

        const result = await runTool(screencastStop, {}, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ frames: 1 });
        expect(String((result.structuredContent as { note?: string }).note)).toContain("time limit");
        expect(methods(fake)).toContain("Page.stopScreencast");
    });

    it("forgets a recording when its tab is forgotten", async () => {
        const { runtime } = setup();

        await runTool(screencastStart, {}, extra(), runtime);
        await runtime.forgetTab("tab1");

        expect(runtime.screencast.recording("tab1")).toBe(false);
    });
});

describe("screencast_stop", () => {
    async function recorded(video: Partial<VideoTools> = {}, frames = 3) {
        const made = setup(video);

        await runTool(screencastStart, {}, extra(), made.runtime);

        for (let index = 0; index < frames; index += 1) frame(made.fake, index);

        const result = await runTool(screencastStop, {}, extra(), made.runtime);

        return { ...made, result };
    }

    it("saves the frames and their durations when ffmpeg is not found", async () => {
        const { result, files } = await recorded();

        expect(result.structuredContent).toMatchObject({
            tab   : "tab1",
            format: "frames",
            path  : DIR,
            frames: 3,
        });
        expect(String((result.structuredContent as { note?: string }).note)).toContain("ffmpeg was not found");
        expect([...files.keys()]).toEqual([
            "frame-00001.jpg",
            "frame-00002.jpg",
            "frame-00003.jpg",
            "frames.txt",
        ]);
        expect(String(files.get("frames.txt"))).toBe(
            [
                "file 'frame-00001.jpg'",
                "duration 0.100",
                "file 'frame-00002.jpg'",
                "duration 0.100",
                "file 'frame-00003.jpg'",
                "duration 0.500",
                "file 'frame-00003.jpg'",
                "",
            ].join("\n"),
        );
        expect(Buffer.from(files.get("frame-00001.jpg") as Uint8Array).toString()).toBe("jpeg-0");
        expect((result.structuredContent as { bytes: number }).bytes).toBe(18);
    });

    it("saves a video and removes the frames when ffmpeg encodes them", async () => {
        const { result, files, removed } = await recorded({ find: async () => "/usr/bin/ffmpeg" });
        const output = result.structuredContent as {
            format: string;
            path  : string;
            bytes : number;
            note? : string;
        };

        expect(output).toMatchObject({ format: "mp4", path: `${DIR}/recording.mp4`, bytes: 4096 });
        expect(output.note).toBeUndefined();
        expect(removed).toEqual([
            "frame-00001.jpg",
            "frame-00002.jpg",
            "frame-00003.jpg",
            "frames.txt",
        ]);
        expect(files.size).toBe(0);
    });

    it("keeps the frames and says why when ffmpeg cannot encode them", async () => {
        const { result, files } = await recorded({
            find: async () => "/usr/bin/ffmpeg",
            run : async () => ({ ok: false, error: "no encoder" }),
        });
        const output = result.structuredContent as { format: string; note: string };

        expect(output.format).toBe("frames");
        expect(output.note).toContain("ffmpeg could not encode the frames (webm: no encoder)");
        expect(files.has("frames.txt")).toBe(true);
    });

    it("says so when no frame was recorded and when nothing is recording", async () => {
        const made = setup();

        await runTool(screencastStart, {}, extra(), made.runtime);
        const empty = await runTool(screencastStop, {}, extra(), made.runtime);

        expect(empty.isError).toBe(true);
        expect(text(empty)).toContain("No frame was recorded");

        const none = await runTool(screencastStop, {}, extra(), made.runtime);

        expect(none.isError).toBe(true);
        expect(text(none)).toContain("screencast_start");
    });

    it("stops the screencast and stops listening", async () => {
        const { fake } = await recorded();

        expect(methods(fake)).toContain("Page.stopScreencast");
        expect(fake.unsubscribed.map((entry) => entry.event)).toContain("Page.screencastFrame");
    });

    it("is refused for lack of a directory without leaving the recording behind", async () => {
        const fake = new FakeAccess({
            tabs: [{ targetId: "tab1", url: "https://a.example/", title: "t", owned: true, created: true }],
        });
        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

        runtime.attach();
        runtime.tabs.select("tab1");
        await runTool(screencastStart, {}, extra(), runtime);
        frame(fake, 0);

        const result = await runTool(screencastStop, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("no directory for files");
        expect(runtime.screencast.recording("tab1")).toBe(false);
    });
});

describe("screencast tools and the safety options", () => {
    it("are reading tools that work in read-only mode", async () => {
        const made = setup();
        const readOnly = new ToolRuntime({
            access: made.fake.asAccess(),
            config: { ...managedConfig, safety: { ...managedConfig.safety, readOnly: true } },
        });

        readOnly.attach();
        readOnly.tabs.select("tab1");

        expect((await runTool(screencastStart, {}, extra(), readOnly)).isError).not.toBe(true);
    });
});
