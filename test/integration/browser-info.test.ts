import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/info", html("<p>info</p>"));
});

afterAll(async () => {
    await env?.stop();
});

describe.skipIf(!present)("browser_info in a real browser", () => {
    it("reports the version of the running browser", async () => {
        const tab = await env.open("/info");
        const info = await env.ok("browser_info", { tab });

        expect(info.product).toMatch(/Chrome\/\d+\./);
        expect(info.userAgent).toContain("Chrome/");
        expect(String(info.protocolVersion)).toMatch(/^\d+\.\d+$/);
        expect(info).toMatchObject({ browser: "chrome", mode: "managed" });
    });
});
