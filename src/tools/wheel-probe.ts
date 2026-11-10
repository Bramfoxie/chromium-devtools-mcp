import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { bindAccess } from "./frame-scope.js";
import { ownerGeometry } from "./frame-geometry.js";
import type { FrameState } from "./frames.js";

const WORLD_NAME = "chromium-devtools-mcp-wheel";

const hitSchema = z.object({ frameId: z.string(), backendNodeId: z.number().optional() });
const describedSchema = z.object({ node: z.object({ frameId: z.string().optional() }) });
const modelSchema = z.object({ model: z.object({
    content: z.array(z.number()).length(8),
    border : z.array(z.number()).length(8),
    width  : z.number(),
    height : z.number(),
}) });
const worldSchema = z.object({ executionContextId: z.number() });
const valueSchema = z.object({ result: z.object({ value: z.boolean() }) });

export async function withWheelProbe<T>(
    access: DaemonAccess,
    frames: FrameState,
    tab   : string,
    point : { x: number; y: number },
    run   : (read: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
    let contextId: number | undefined;
    let installed = false;
    let owner = access;
    const key = `cdmWheelProbe_${randomUUID()}`;
    const keyLiteral = JSON.stringify(key);
    const evaluate = async (expression: string): Promise<unknown> => owner.send({
        targetId: tab,
        method  : "Runtime.evaluate",
        params  : { expression, contextId, returnByValue: true },
    });

    try {
        try {
            await frames.refresh(tab).catch(() => undefined);
            let local = point;
            let frameId: string | undefined;
            const visited = new Set<string>();

            while (true) {
                const hit = hitSchema.parse(await owner.send({
                    targetId: tab,
                    method  : "DOM.getNodeForLocation",
                    params  : { x: Math.floor(local.x), y: Math.floor(local.y) },
                }));

                frameId = hit.frameId;
                if (hit.backendNodeId === undefined) break;

                const described = describedSchema.safeParse(await owner.send({
                    targetId: tab,
                    method  : "DOM.describeNode",
                    params  : { backendNodeId: hit.backendNodeId },
                }).catch(() => undefined));
                const child = described.success ? described.data.node.frameId : undefined;

                if (child === undefined || child === frameId) break;
                if (visited.has(child)) throw new Error("Frame cycle detected");

                const info = frames.frameOf(tab, child);

                if (info === undefined || !info.isolated) throw new Error("Frame session unavailable");

                const model = modelSchema.parse(await owner.send({
                    targetId: tab,
                    method  : "DOM.getBoxModel",
                    params  : { backendNodeId: hit.backendNodeId },
                }));
                const transform = ownerGeometry(model.model).transform;

                if (transform.scaleX <= 0 || transform.scaleY <= 0) throw new Error("Invalid frame geometry");

                local = {
                    x: (local.x - transform.x) / transform.scaleX,
                    y: (local.y - transform.y) / transform.scaleY,
                };
                visited.add(child);
                frameId = child;
                if (info.isolated) owner = bindAccess(access, child);
            }

            if (frameId !== undefined) {
                const world = worldSchema.safeParse(await owner.send({
                    targetId: tab,
                    method  : "Page.createIsolatedWorld",
                    params  : { frameId, worldName: WORLD_NAME },
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
