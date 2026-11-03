import { vi } from "vitest";

export interface FakeClock {
    advance: (ms: number) => Promise<void>;
    restore: () => void;
}

export function useFakeClock(): FakeClock {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    return {
        advance: async (ms) => void (await vi.advanceTimersByTimeAsync(ms)),
        restore: () => void vi.useRealTimers(),
    };
}

export async function flushMicrotasks(rounds = 20): Promise<void> {
    for (let round = 0; round < rounds; round += 1) await Promise.resolve();
}
