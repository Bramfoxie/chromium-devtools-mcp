import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/stop", html("<title>Stop test</title>"));
});

afterAll(async () => {
    await env?.stop();
});

describe.skipIf(!present)("stopping page loading in a real browser", () => {
    it("accepts the stop command for a tab", async () => {
        const tab = await env.open("/stop");
        const result = await env.ok("page_navigate", { tab, action: "stop" });

        expect(result).toMatchObject({ tab, navigationType: "stop", waited: "none" });
    });
});
