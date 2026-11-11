import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, eventually, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

const BENCH = "(() => { const t = performance.now(); let x = 0; for (let i = 0; i < 4e7; i += 1) x += i % 7; return { elapsed: performance.now() - t, checksum: x }; })()";
const CHECKSUM = 119_999_995;

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

function elapsedValue(result: unknown): number {
    expect(result).toMatchObject({ checksum: CHECKSUM, elapsed: expect.any(Number) });

    return (result as { elapsed: number }).elapsed;
}

async function elapsed(tab: string): Promise<number> {
    const samples: number[] = [];

    for (let i = 0; i < 3; i += 1) {
        const result = await env.ok("js_evaluate", { tab, expression: BENCH });

        samples.push(elapsedValue(result.value));
    }

    return samples.reduce((sum, sample) => sum + sample, 0);
}

describe.skipIf(!present)("emulate_cpu in a real browser", () => {
    it("slows work in a cross site frame", async () => {
        const tab = await env.open("/cpu-frame");

        try {
            await eventually(async () => {
                const snapshot = await env.ok("dom_snapshot", { tab });
                const frames = snapshot.frames as Array<{ isolated?: boolean }>;

                return frames.some((frame) => frame.isolated === true) ? true : undefined;
            });
            const expression = "new Promise(resolve => { addEventListener('message', e => resolve(e.data), { once: true }); frames[0].postMessage('run', '*'); })";
            const sample = async () => elapsedValue((await env.ok("js_evaluate", { tab, expression })).value);
            const normal = (await sample()) + (await sample()) + (await sample());

            await env.ok("emulate_cpu", { tab, slowdown: 6 });

            const slow = (await sample()) + (await sample()) + (await sample());

            expect(slow).toBeGreaterThan(normal * 2);
        } finally {
            try {
                await env.ok("emulate_cpu", { tab, reset: true });
            } finally {
                await env.ok("close_tab", { tab });
            }
        }
    });

    it("slows work and removes the override when reset", async () => {
        const tab = await env.open("/cpu");

        try {
            const normal = await elapsed(tab);

            await env.ok("emulate_cpu", { tab, slowdown: 6 });
            const slowed = await elapsed(tab);

            expect(slowed).toBeGreaterThan(normal * 2);

            const state = await env.ok("emulate_cpu", { tab, reset: true });

            expect(JSON.stringify(state)).not.toContain("slowdown");
            expect(await elapsed(tab)).toBeLessThan(slowed);
        } finally {
            try {
                await env.ok("emulate_cpu", { tab, reset: true });
            } finally {
                await env.ok("close_tab", { tab });
            }
        }
    });
});
