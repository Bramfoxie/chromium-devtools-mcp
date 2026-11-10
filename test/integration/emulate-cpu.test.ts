import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

const BENCH = "(() => { const t = performance.now(); let x = 0; for (let i = 0; i < 4e6; i += 1) x += i % 7; return performance.now() - t; })()";

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/cpu", html("<p>cpu</p>"));
});

afterAll(async () => {
    await env?.stop();
});

async function elapsed(tab: string): Promise<number> {
    const samples: number[] = [];

    for (let i = 0; i < 3; i += 1) {
        const result = await env.ok("js_evaluate", { tab, expression: BENCH });

        samples.push(Number((result as { value?: unknown }).value));
    }

    return Math.min(...samples);
}

describe.skipIf(!present)("emulate_cpu in a real browser", () => {
    it("makes the same work take clearly longer and restores full speed", async () => {
        const tab = await env.open("/cpu");
        const normal = await elapsed(tab);

        await env.ok("emulate_cpu", { tab, slowdown: 6 });

        const slowed = await elapsed(tab);

        expect(slowed).toBeGreaterThan(normal * 2);

        const state = await env.ok("emulate_cpu", { tab, reset: true });

        expect(JSON.stringify(state)).not.toContain("slowdown");
        expect(await elapsed(tab)).toBeLessThan(slowed);
    });
});
