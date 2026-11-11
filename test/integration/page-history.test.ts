import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/history-a", html("<title>First</title>"));
    env.fixture.pages.set("/history-b", html("<title>Second</title>"));
});

afterAll(async () => {
    await env?.stop();
});

describe.skipIf(!present)("page history in a real browser", () => {
    it("lists pages visited by the session tab", async () => {
        const tab = await env.open("/history-a");

        await env.ok("page_navigate", { tab, url: `${env.fixture.origin}/history-b` });
        const result = await env.ok("page_history", { tab });
        const entries = result.entries as Array<{ url: string }>;

        expect(entries.map((entry) => entry.url)).toEqual(expect.arrayContaining([
            `${env.fixture.origin}/history-a`, `${env.fixture.origin}/history-b`,
        ]));
        expect(entries[result.currentIndex as number]?.url).toBe(`${env.fixture.origin}/history-b`);
    });
});
