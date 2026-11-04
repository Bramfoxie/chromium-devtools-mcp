import { describe, expect, it } from "vitest";
import { holdRendering, startRecording, startRendering } from "../src/tools/hold-rendering.js";
import { FakeAccess } from "./helpers/fake-access.js";

function setup(): FakeAccess {
    const fake = new FakeAccess();

    fake.respond = () => ({});

    return fake;
}

function methods(fake: FakeAccess): string[] {
    return fake.sent.map((call) => call.method);
}

describe("holdRendering", () => {
    it("starts a sparse screencast before the work and stops it after", async () => {
        const fake = setup();

        const result = await holdRendering(fake.asAccess(), "tab1", async () => {
            fake.sent.push({ targetId: "tab1", method: "work" });

            return 7;
        });

        expect(result).toBe(7);
        expect(methods(fake)).toEqual(["Page.startScreencast", "work", "Page.stopScreencast"]);
        expect(fake.sent[0]?.params).toEqual({ format: "jpeg", quality: 1, everyNthFrame: 1000 });
    });

    it("stops the screencast when the work fails", async () => {
        const fake = setup();

        await expect(holdRendering(fake.asAccess(), "tab1", async () => {
            throw new Error("boom");
        })).rejects.toThrow("boom");

        expect(methods(fake)).toEqual(["Page.startScreencast", "Page.stopScreencast"]);
    });

    it("tolerates a browser that rejects the screencast", async () => {
        const fake = setup();

        fake.respond = () => {
            throw new Error("no screencast");
        };

        const release = await startRendering(fake.asAccess(), "tab1");

        await expect(release()).resolves.toBeUndefined();
    });

    it("starts the screencast once for overlapping holds and stops it when the last one lets go", async () => {
        const fake = setup();
        const first = await startRendering(fake.asAccess(), "tab1");
        const second = await startRendering(fake.asAccess(), "tab1");
        const other = await startRendering(fake.asAccess(), "tab2");

        await first();
        await first();

        expect(fake.sent.map((call) => `${call.targetId} ${call.method}`)).toEqual([
            "tab1 Page.startScreencast",
            "tab2 Page.startScreencast",
        ]);

        await second();
        await other();

        expect(fake.sent.map((call) => `${call.targetId} ${call.method}`)).toEqual([
            "tab1 Page.startScreencast",
            "tab2 Page.startScreencast",
            "tab1 Page.stopScreencast",
            "tab2 Page.stopScreencast",
        ]);
    });
});

describe("startRecording", () => {
    const params = { format: "jpeg" as const, quality: 60, maxWidth: 1280, everyNthFrame: 4 };
    const log = (fake: ReturnType<typeof setup>) =>
        fake.sent.map((call) => {
            const quality = (call.params as { quality?: number } | undefined)?.quality;

            return `${call.method}${quality === undefined ? "" : ` q${quality}`}`;
        });

    it("starts a screencast with its own settings and stops it when it ends", async () => {
        const fake = setup();
        const end = await startRecording(fake.asAccess(), "tab1", params);

        await end();
        await end();

        expect(log(fake)).toEqual(["Page.startScreencast q60", "Page.stopScreencast"]);
    });

    it("takes the screencast over from a hold and gives it back when it ends", async () => {
        const fake = setup();
        const release = await startRendering(fake.asAccess(), "tab1");
        const end = await startRecording(fake.asAccess(), "tab1", params);

        await end();

        expect(log(fake)).toEqual([
            "Page.startScreencast q1",
            "Page.stopScreencast",
            "Page.startScreencast q60",
            "Page.stopScreencast",
            "Page.startScreencast q1",
        ]);

        await release();

        expect(log(fake).at(-1)).toBe("Page.stopScreencast");
    });

    it("lets a hold that starts during a recording share the screencast without disturbing it", async () => {
        const fake = setup();
        const end = await startRecording(fake.asAccess(), "tab1", params);
        const release = await startRendering(fake.asAccess(), "tab1");

        await release();

        expect(log(fake)).toEqual(["Page.startScreencast q60"]);

        await end();

        expect(log(fake)).toEqual(["Page.startScreencast q60", "Page.stopScreencast"]);
    });

    it("keeps the hold running when the recording cannot start", async () => {
        const fake = setup();
        const release = await startRendering(fake.asAccess(), "tab1");

        fake.failSend = (_tab, method) =>
            method === "Page.startScreencast" && fake.sent.length > 2 ? new Error("refused") : undefined;

        await expect(startRecording(fake.asAccess(), "tab1", params)).rejects.toThrow("refused");

        fake.failSend = undefined;
        await release();

        expect(log(fake)).toEqual([
            "Page.startScreencast q1",
            "Page.stopScreencast",
            "Page.startScreencast q60",
            "Page.startScreencast q1",
            "Page.stopScreencast",
        ]);
    });
});
