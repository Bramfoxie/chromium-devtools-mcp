import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpClient } from "../src/cdp/index.js";
import { CdpBackend } from "../src/daemon/cdp-backend.js";
import { SessionRegistry } from "../src/daemon/sessions.js";
import { FakeBrowser } from "./helpers/fake-browser.js";

const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined);
});

async function setup() {
    const browser = new FakeBrowser();
    const url = await browser.start();

    stops.push(() => browser.stop());
    const client = await CdpClient.connect({ url, requestTimeoutMs: 2000 });

    stops.push(() => client.close());
    const backend = await CdpBackend.create(client);
    const registry = new SessionRegistry<string>(backend, { allowFocus: false });
    const session = await registry.open("a", () => undefined, {
        isolated  : false,
        clientName: "client-a",
    });

    return { browser, session };
}

describe("frame listing through the CDP backend", () => {
    it("lists the page frame tree with nested out of process frames", async () => {
        const { browser, session } = await setup();
        const tab = await session.createTab("https://a.example/");

        await session.listFrames(tab);
        const outer = browser.attachChild(tab, "outer", "https://b.example/");

        await session.listFrames(tab);
        browser.attachNestedChild(outer, "inner", "https://c.example/");

        const frames = await vi.waitFor(async () => {
            const listed = await session.listFrames(tab);

            expect(listed.filter((frame) => frame.isolated)).toHaveLength(2);

            return listed;
        });

        const shape = frames.map((frame) => [frame.frameId, frame.parentFrameId, frame.isolated]);

        expect(shape).toEqual([
            [`main-${tab}`, undefined, false],
            ["outer", `main-${tab}`, true],
            ["inner", "outer", true],
        ]);
    });

    it("routes a command to a nested frame session", async () => {
        const { browser, session } = await setup();
        const tab = await session.createTab("https://a.example/");

        await session.listFrames(tab);
        const outer = browser.attachChild(tab, "outer", "https://b.example/");

        await vi.waitFor(() =>
            expect(browser.calls.some((call) => call.sessionId === outer)).toBe(true),
        );
        browser.attachNestedChild(outer, "inner", "https://c.example/");
        await vi.waitFor(async () => {
            await session.listFrames(tab);
            await session.send({ targetId: tab, method: "Runtime.evaluate", params: { expression: "1" }, frameId: "inner" });
        });

        const call = browser.calls.find((entry) => entry.method === "Runtime.evaluate");

        expect(call?.sessionId).toBe(browser.childSessionIds()[1]);
    });
});
