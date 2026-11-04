import { describe, expect, it } from "vitest";
import {
    actionWaitOf,
    DEFAULT_ACTION_WAIT_MS,
    retryWhileRefused,
    ToolError,
    TransientRefusal,
} from "../src/tools/index.js";

function fakeClock() {
    let time = 0;
    const sleeps: number[] = [];

    return {
        clock: {
            now  : () => time,
            sleep: async (ms: number) => {
                sleeps.push(ms);
                time += ms;
            },
        },
        sleeps,
    };
}

describe("retryWhileRefused", () => {
    it("returns at once when the first attempt works", async () => {
        const { clock, sleeps } = fakeClock();
        const value = await retryWhileRefused(actionWaitOf(1000, clock), async () => 7);

        expect(value).toBe(7);
        expect(sleeps).toEqual([]);
    });

    it("tries again every 100 ms until the element is ready", async () => {
        const { clock, sleeps } = fakeClock();
        let calls = 0;
        const value = await retryWhileRefused(actionWaitOf(1000, clock), async () => {
            calls += 1;

            if (calls < 4) throw new TransientRefusal("The element is disabled.");

            return "done";
        });

        expect(value).toBe("done");
        expect(calls).toBe(4);
        expect(sleeps).toEqual([100, 100, 100]);
    });

    it("gives up at the timeout and says how long it waited", async () => {
        const { clock, sleeps } = fakeClock();
        const failing = retryWhileRefused(actionWaitOf(250, clock), async () => {
            throw new TransientRefusal("The element is hidden.");
        });

        await expect(failing).rejects.toThrow("The element is hidden. It did not change within 250 ms.");
        expect(sleeps).toEqual([100, 100, 50]);
    });

    it("does not wait when the timeout is 0 and keeps the original message", async () => {
        const { clock, sleeps } = fakeClock();
        const failing = retryWhileRefused(actionWaitOf(0, clock), async () => {
            throw new TransientRefusal("The element is hidden.");
        });

        await expect(failing).rejects.toThrow(/^The element is hidden\.$/);
        expect(sleeps).toEqual([]);
    });

    it("never retries an error that waiting cannot fix", async () => {
        const { clock, sleeps } = fakeClock();
        let calls = 0;
        const failing = retryWhileRefused(actionWaitOf(1000, clock), async () => {
            calls += 1;

            throw new ToolError("The element is no longer attached to the page.");
        });

        await expect(failing).rejects.toThrow("no longer attached");
        expect(calls).toBe(1);
        expect(sleeps).toEqual([]);
    });

    it("stops after a bounded number of tries even when the clock does not advance", async () => {
        let calls = 0;
        const stuck = { now: () => 0, sleep: async () => undefined };
        const failing = retryWhileRefused(actionWaitOf(1000, stuck), async () => {
            calls += 1;

            throw new TransientRefusal("The element is hidden.");
        });

        await expect(failing).rejects.toThrow("did not change");
        expect(calls).toBe(11);
    });

    it("does not retry without a wait", async () => {
        let calls = 0;
        const failing = retryWhileRefused(undefined, async () => {
            calls += 1;

            throw new TransientRefusal("The element is disabled.");
        });

        await expect(failing).rejects.toThrow("disabled");
        expect(calls).toBe(1);
    });
});

describe("actionWaitOf", () => {
    it("defaults to two seconds and keeps an explicit value, also 0", () => {
        const { clock } = fakeClock();

        expect(DEFAULT_ACTION_WAIT_MS).toBe(2000);
        expect(actionWaitOf(undefined, clock).timeoutMs).toBe(2000);
        expect(actionWaitOf(0, clock).timeoutMs).toBe(0);
        expect(actionWaitOf(500, clock).timeoutMs).toBe(500);
    });
});
