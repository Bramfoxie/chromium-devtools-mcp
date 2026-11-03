import { describe, expect, it } from "vitest";
import { holdRendering, startRendering } from "../src/tools/hold-rendering.js";
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
