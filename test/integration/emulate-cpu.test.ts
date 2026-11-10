import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

const BENCH = "(() => { const t = performance.now(); let x = 0; for (let i = 0; i < 4e7; i += 1) x += i % 7; return performance.now() - t; })()";

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/cpu", html("<p>cpu</p>"));
    env.other.pages.set("/cpu-child", html(`<script>onmessage = () => parent.postMessage(${BENCH}, '*')</script>`));
    env.fixture.pages.set("/cpu-frame", html(`<iframe src="${env.other.origin}/cpu-child"></iframe>`));
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
    it("slows work in a cross site frame", async () => {
        const tab = await env.open("/cpu-frame");
        const expression = "new Promise(resolve => { addEventListener('message', e => resolve(e.data), { once: true }); frames[0].postMessage('run', '*'); })";
        const sample = async () => Number((await env.ok("js_evaluate", { tab, expression })).value);
        const normal = Math.min(await sample(), await sample(), await sample());

        await env.ok("emulate_cpu", { tab, slowdown: 6 });
        const slow = Math.min(await sample(), await sample(), await sample());

        expect(slow).toBeGreaterThan(normal * 2);
    });

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
