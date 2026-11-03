import { describe, expect, it } from "vitest";
import type { CdpCommand, DaemonAccess } from "../src/mcp/index.js";
import { CANCELLED_MESSAGE } from "../src/tools/index.js";
import {
    FRAME_ATTEMPTS,
    MOVE_BUDGET_MS,
    type PointerRoute,
    type PointerTarget,
    withPointerDelivery,
} from "../src/tools/pointer-delivery.js";

function fakeClock() {
    let time = 1_000_000;

    return {
        advance: (ms: number) => void (time += ms),
        clock  : {
            now  : () => time,
            sleep: async (ms: number) => void (time += ms),
        },
    };
}

function routeOf(options: { moveSeen: boolean; onWait?: () => void }): PointerRoute {
    const owner = {
        send: async ({ params }: CdpCommand) => {
            const declaration = String(params?.functionDeclaration);

            if (declaration.includes("cdmProbeRead")) {
                return { result: { value: { moves: 0, downs: 0 } } };
            }

            if (declaration.includes("cdmProbeWait")) {
                options.onWait?.();

                return { result: { value: options.moveSeen ? 1 : 0 } };
            }

            return { result: { value: true } };
        },
    } as unknown as DaemonAccess;
    const measurement = {
        point: { x: 10, y: 10 },
        local: { x: 5, y: 5 },
        boxes: [],
    };

    return {
        owner,
        frameId : "frame",
        objectId: "obj",
        relays  : [],
        links   : [],
        initial : measurement,
        measure : async () => measurement,
        release : async () => undefined,
    };
}

describe("PointerDelivery.prepareMove", () => {
    it("returns the first target when the frame sees the move", async () => {
        const { clock } = fakeClock();
        const moved: PointerTarget[] = [];
        const target = await withPointerDelivery(
            routeOf({ moveSeen: true }),
            "tab1",
            { clock, signal: new AbortController().signal },
            async (delivery) => delivery?.prepareMove(async (at) => void moved.push(at)),
        );

        expect(target?.via).toBe("frame");
        expect(moved).toHaveLength(1);
    });

    it("gives up after the frame attempts and the tab budget on the injected clock", async () => {
        const fake = fakeClock();
        const moved: PointerTarget[] = [];
        const failure = await withPointerDelivery(
            routeOf({ moveSeen: false, onWait: () => fake.advance(100) }),
            "tab1",
            { clock: fake.clock, signal: new AbortController().signal },
            async (delivery) => delivery?.prepareMove(async (at) => void moved.push(at)),
        ).catch((error: unknown) => error);

        expect((failure as Error).message).toContain("did not receive pointer input");
        expect(moved.slice(0, FRAME_ATTEMPTS).every((at) => at.via === "frame")).toBe(true);
        expect(moved.at(-1)?.via).toBe("tab");
        expect((failure as Error).message).toMatch(/elapsedMs=(\d+)/);

        const elapsed = Number(/elapsedMs=(\d+)/.exec((failure as Error).message)?.[1]);

        expect(elapsed).toBeGreaterThanOrEqual(MOVE_BUDGET_MS);
    });

    it("stops retrying when the signal aborts", async () => {
        const fake = fakeClock();
        const controller = new AbortController();
        let moves = 0;
        const failure = await withPointerDelivery(
            routeOf({ moveSeen: false, onWait: () => fake.advance(100) }),
            "tab1",
            { clock: fake.clock, signal: controller.signal },
            async (delivery) =>
                delivery?.prepareMove(async () => {
                    moves += 1;

                    if (moves === 2) controller.abort();
                }),
        ).catch((error: unknown) => error);

        expect((failure as Error).message).toBe(CANCELLED_MESSAGE);
        expect(moves).toBe(2);
    });
});
