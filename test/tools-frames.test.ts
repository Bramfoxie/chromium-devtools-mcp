import { describe, expect, it } from "vitest";
import { FRAME_EVENTS, FrameState, ToolError } from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";

function setup() {
    const fake = new FakeAccess({
        frames: [
            { frameId: "main", url: "https://a.example/", name: "", isolated: false },
            {
                frameId      : "cross",
                parentFrameId: "main",
                url          : "https://b.example/",
                name         : "pay",
                isolated     : true,
            },
        ],
    });
    const frames = new FrameState({ access: fake.asAccess() });

    frames.attach();

    return { fake, frames };
}

function emit(
    fake  : FakeAccess,
    event : string,
    params: unknown,
    targetId = "tab1",
): void {
    fake.emit("cdp.event", { targetId, event, params });
}

describe("FrameState", () => {
    it("does not overwrite a frame navigation event with an older tree", async () => {
        const { fake, frames } = setup();

        await frames.ensure("tab1");
        const list = fake.listFrames.bind(fake);
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));

        fake.listFrames = async (tab) => {
            const result = await list(tab);

            await gate;

            return result;
        };

        const pending = frames.refresh("tab1");

        await Promise.resolve();
        emit(fake, "Page.frameNavigated", { frame: { id: "main", url: "https://new.example/" } });
        release();
        await pending;
        expect(frames.frameOf("tab1", "main")?.url).toBe("https://new.example/");
    });

    it("does not replace a newer frame tree with a late older refresh", async () => {
        const { fake, frames } = setup();

        await frames.ensure("tab1");
        let release: () => void = () => undefined;
        let calls = 0;
        const gate = new Promise<void>((resolve) => (release = resolve));

        fake.listFrames = async () => {
            calls += 1;

            if (calls === 1) {
                await gate;

                return [{ frameId: "old", url: "https://old.example/", name: "", isolated: false }];
            }

            return [{ frameId: "new", url: "https://new.example/", name: "", isolated: false }];
        };

        const older = frames.refresh("tab1");

        await frames.refresh("tab1");
        release();
        await older;
        expect(frames.framesOf("tab1").map((item) => item.frameId)).toEqual(["new"]);
    });

    it.each(["forget", "reset"])("rejects a late refresh after %s", async (action) => {
        const { fake, frames } = setup();

        await frames.ensure("tab1");
        const list = fake.listFrames.bind(fake);
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));

        fake.listFrames = async (tab) => {
            const result = await list(tab);

            await gate;

            return result;
        };

        const pending = frames.refresh("tab1");

        if (action === "forget") frames.forget("tab1");
        else frames.reset();

        release();
        await expect(pending).rejects.toThrow("The tab closed or the session reset while loading frames.");
        expect(frames.framesOf("tab1")).toEqual([]);
    });

    it.each(["forget", "reset"])("rejects a late frame subscription after %s", async (action) => {
        const { fake, frames } = setup();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));

        fake.subscribe = async () => gate;
        const pending = frames.ensure("tab1");

        await new Promise<void>((resolve) => setImmediate(resolve));
        if (action === "forget") frames.forget("tab1");
        else frames.reset();

        release();
        await expect(pending).rejects.toThrow("The tab closed or the session reset while loading frames.");
        expect(frames.framesOf("tab1")).toEqual([]);
    });

    it.each(["forget", "reset"])("rejects a late frame tree after %s", async (action) => {
        const { fake, frames } = setup();
        const list = fake.listFrames.bind(fake);
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));

        fake.listFrames = async (tab) => {
            const result = await list(tab);

            await gate;

            return result;
        };

        const pending = frames.ensure("tab1");

        if (action === "forget") frames.forget("tab1");
        else frames.reset();

        release();
        await expect(pending).rejects.toThrow("The tab closed or the session reset while loading frames.");
        expect(frames.framesOf("tab1")).toEqual([]);
        expect(fake.subscribed).toEqual([]);
    });

    it("loads the frame tree and subscribes to frame events once", async () => {
        const { fake, frames } = setup();

        await frames.ensure("tab1");
        await frames.ensure("tab1");

        expect(frames.framesOf("tab1")).toEqual([
            { frameId: "main", url: "https://a.example/", name: "", isolated: false },
            {
                frameId      : "cross",
                parentFrameId: "main",
                url          : "https://b.example/",
                name         : "pay",
                isolated     : true,
            },
        ]);
        expect(frames.mainFrame("tab1")).toBe("main");
        expect(fake.subscribed).toEqual(
            [...FRAME_EVENTS].map((event) => ({ targetId: "tab1", event, frameId: undefined })),
        );
        expect(frames.ensured("tab1")).toBe(true);
    });

    it("resolves a known frame id and refreshes before giving up", async () => {
        const { fake, frames } = setup();

        await frames.ensure("tab1");
        expect((await frames.resolve("tab1", "cross")).url).toBe("https://b.example/");

        fake.frames.push({
            frameId      : "late",
            parentFrameId: "main",
            url          : "https://c.example/",
            name         : "",
            isolated     : false,
        });

        expect((await frames.resolve("tab1", "late")).url).toBe("https://c.example/");
    });

    it("reports an unknown frame id with a clear message", async () => {
        const { frames } = setup();

        await frames.ensure("tab1");

        const failure = await frames.resolve("tab1", "nope").catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ToolError);
        expect((failure as Error).message).toContain('No frame "nope"');
    });

    it("bumps the frame generation on navigation and detach, not on attach", async () => {
        const { fake, frames } = setup();

        await frames.ensure("tab1");
        expect(frames.generation("tab1", "cross")).toBe(0);

        emit(fake, "Page.frameNavigated", { frame: { id: "cross", parentId: "main" } });
        expect(frames.generation("tab1", "cross")).toBe(1);
        expect(frames.frameOf("tab1", "cross")).toMatchObject({ frameId: "cross", parentFrameId: "main" });

        emit(fake, "Page.frameDetached", { frameId: "cross" });
        expect(frames.generation("tab1", "cross")).toBe(2);
        expect(frames.frameOf("tab1", "cross")).toBeUndefined();

        emit(fake, "Page.frameAttached", { frameId: "fresh", frame: { id: "fresh" } });
        expect(frames.generation("tab1", "fresh")).toBe(0);
    });

    it("updates the url and name of a frame after it navigates", async () => {
        const { fake, frames } = setup();

        await frames.ensure("tab1");
        emit(fake, "Page.frameNavigated", {
            frame: { id: "cross", parentId: "main", url: "https://c.example/next", name: "renamed" },
            type : "Navigation",
        });
        emit(fake, "Page.frameNavigated", {
            frame: { id: "main", url: "https://a.example/next" },
            type : "Navigation",
        });

        expect(frames.frameOf("tab1", "cross")).toMatchObject({
            url     : "https://c.example/next",
            name    : "renamed",
            isolated: true,
        });
        expect(frames.frameOf("tab1", "main")?.url).toBe("https://a.example/next");
    });

    it("records an attached frame with its parent", async () => {
        const { fake, frames } = setup();

        await frames.ensure("tab1");
        emit(fake, "Page.frameAttached", {
            frameId: "fresh",
            frame  : { id: "fresh", parentId: "main" },
        });

        expect(frames.frameOf("tab1", "fresh")).toEqual({
            frameId      : "fresh",
            parentFrameId: "main",
            url          : "",
            name         : "",
            isolated     : false,
        });
    });

    it("drops gone frames on refresh and bumps their generations", async () => {
        const { fake, frames } = setup();

        await frames.ensure("tab1");
        fake.frames = [
            { frameId: "main", url: "https://a.example/", name: "", isolated: false },
        ];
        await frames.refresh("tab1");

        expect(frames.framesOf("tab1").map((frame) => frame.frameId)).toEqual(["main"]);
        expect(frames.generation("tab1", "cross")).toBe(1);
        expect(frames.generation("tab1", "main")).toBe(0);
    });

    it("ignores events of other tabs and forgets closed tabs", async () => {
        const { fake, frames } = setup();

        await frames.ensure("tab1");
        emit(fake, "Page.frameDetached", { frameId: "cross" }, "tab2");
        expect(frames.frameOf("tab1", "cross")).toMatchObject({ frameId: "cross", parentFrameId: "main" });

        frames.forget("tab1");
        expect(frames.framesOf("tab1")).toEqual([]);
        expect(frames.ensured("tab1")).toBe(false);
        frames.forget("tab2");
        frames.reset();
    });
});
