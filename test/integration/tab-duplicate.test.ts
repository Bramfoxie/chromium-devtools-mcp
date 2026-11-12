import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/duplicate", html("<title>Duplicate</title><p>Original</p>"));
});

afterAll(async () => {
    await env?.stop();
});

describe.skipIf(!present)("tab_duplicate in a real browser", () => {
    it("opens the source address without changing the selected tab", async () => {
        const source = await env.open("/duplicate");
        const copy = await env.ok("tab_duplicate", { tab: source });
        const tab = copy.tab as { tab: string; url: string; title: string };

        expect(tab.tab).not.toBe(source);
        expect(tab.url).toBe(`${env.fixture.origin}/duplicate`);
        expect(tab.title).toBe("Duplicate");
        const tabs = await env.ok("list_tabs");

        expect(tabs.tabs).toEqual(expect.arrayContaining([
            expect.objectContaining({ tab: source, selected: true }),
            expect.objectContaining({ tab: tab.tab, selected: false }),
        ]));
    });
});
