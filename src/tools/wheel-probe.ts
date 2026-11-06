import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";

const hitSchema = z.object({ frameId: z.string() });
const worldSchema = z.object({ executionContextId: z.number() });
const valueSchema = z.object({ result: z.object({ value: z.boolean() }) });

export async function withWheelProbe<T>(
    access: DaemonAccess,
    tab   : string,
    point : { x: number; y: number },
    run   : (read: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
    let contextId: number | undefined;
    let installed = false;
    const key = `cdmWheelProbe_${randomUUID()}`;
    const keyLiteral = JSON.stringify(key);
    const evaluate = async (expression: string): Promise<unknown> => access.send({
        targetId: tab,
        method  : "Runtime.evaluate",
        params  : { expression, contextId, returnByValue: true },
    });

    try {
        try {
            const hit = hitSchema.safeParse(await access.send({
                targetId: tab,
                method  : "DOM.getNodeForLocation",
                params  : { x: Math.floor(point.x), y: Math.floor(point.y) },
            }));

            if (hit.success) {
                const world = worldSchema.safeParse(await access.send({
                    targetId: tab,
                    method  : "Page.createIsolatedWorld",
                    params  : { frameId: hit.data.frameId, worldName: key },
                }));

                if (world.success) {
                    contextId = world.data.executionContextId;
                    const result = valueSchema.safeParse(await evaluate(`(() => { /* cdmWheelProbeInstall */ const state = { seen: false }; state.listener = (event) => { if (event.isTrusted) state.seen = true; }; document.addEventListener("wheel", state.listener, true); globalThis[${keyLiteral}] = state; return true; })()`));

                    installed = result.success && result.data.result.value;
                }
            }
        } catch {
            installed = false;
        }

        return await run(async () => {
            if (contextId === undefined || !installed) return false;

            try {
                const result = valueSchema.safeParse(await evaluate(`(() => { /* cdmWheelProbeRead */ return globalThis[${keyLiteral}]?.seen === true; })()`));

                return result.success && result.data.result.value;
            } catch {
                return false;
            }
        });
    } finally {
        if (contextId !== undefined) {
            await evaluate(`(() => { /* cdmWheelProbeRemove */ const state = globalThis[${keyLiteral}]; if (state) { document.removeEventListener("wheel", state.listener, true); delete globalThis[${keyLiteral}]; } return true; })()`).catch(() => undefined);
        }
    }
}
