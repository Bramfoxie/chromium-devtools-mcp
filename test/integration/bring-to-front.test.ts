import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let closed: Env;
let open: Env;

beforeAll(async () => {
    if (!present) return;

    closed = await startEnv();
    open = await startEnv(undefined, true);
    closed.fixture.pages.set("/a", html("<p>a</p>"));
    open.fixture.pages.set("/a", html("<p>a</p>"));
});

afterAll(async () => {
    await closed?.stop();
    await open?.stop();
});

describe.skipIf(!present)("bring_to_front in a real browser", () => {
    it("is refused while allowFocus is off", async () => {
        const tab = await closed.open("/a");
        const result = await closed.call("bring_to_front", { tab });

        expect(result.isError).toBe(true);
        expect(result.text).toContain("allowFocus");
    });

    it("brings the tab to the front when allowFocus is on", async () => {
        const tab = await open.open("/a");
        const result = await open.ok("bring_to_front", { tab });

        expect(result).toEqual({ tab });
    });
});
