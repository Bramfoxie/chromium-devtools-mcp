import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import type { ToolContext } from "./define-tool.js";
import { ToolError } from "./errors.js";
import { frameChain, mapRect, measureChain } from "./frame-geometry.js";
import { bindAccess } from "./frame-scope.js";
import { passwordNodeIds, type Rect } from "./screenshot-mask-image.js";

const boxSchema = z.object({
    model: z.object({
        border : z.array(z.number()).length(8),
        content: z.array(z.number()).length(8).optional(),
    }),
});

function maskError(): ToolError {
    return new ToolError("Password masking could not cover the screenshot. Retry without masking only if the image can be shared safely.");
}

function bounds(quad: number[]): Rect {
    const xs = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
    const ys = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0];
    const x = Math.min(...xs);
    const y = Math.min(...ys);

    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function axisAligned(quad: number[]): boolean {
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] = quad;

    return x1 > x0 && y3 > y0 && Math.abs(y1 - y0) < 0.5 && Math.abs(y2 - y3) < 0.5 &&
        Math.abs(x3 - x0) < 0.5 && Math.abs(x2 - x1) < 0.5;
}

async function modelOf(access: DaemonAccess, tab: string, backendNodeId: number) {
    const parsed = boxSchema.safeParse(await access.send({
        targetId: tab, method: "DOM.getBoxModel", params: { backendNodeId },
    }));

    if (!parsed.success) throw maskError();

    return parsed.data.model;
}

export async function passwordBoxes(context: ToolContext, tab: string): Promise<Rect[]> {
    try {
        const frames = await context.frames.refresh(tab);

        if (frames.some((frame) => frame.truncated === true) ||
            frames.length > 100 ||
            frames.filter((frame) => frame.parentFrameId === undefined).length !== 1) {
            throw maskError();
        }

        const sessions = [undefined,
            ...frames.filter((frame) => frame.isolated).map((frame) => frame.frameId)];
        const boxes: Rect[] = [];

        for (const frame of sessions) {
            const access = frame === undefined ? context.access : bindAccess(context.access, frame);
            const snapshot = await access.send({
                targetId: tab, method: "DOMSnapshot.captureSnapshot", params: { computedStyles: [] },
            });
            const ids = passwordNodeIds(snapshot);

            if (ids.length + boxes.length > 1000) throw maskError();
            if (ids.length === 0) continue;

            const chain = frame === undefined
                ? undefined : await frameChain(context.access, context.frames, tab, frame);

            if (chain !== undefined) {
                if (chain.links.length === 0) throw maskError();

                for (const link of chain.links) {
                    const model = await modelOf(link.access, tab, link.backendNodeId);

                    if (model.content === undefined || !axisAligned(model.content) ||
                        !axisAligned(model.border)) throw maskError();
                }
            }

            const transform = chain === undefined
                ? undefined : (await measureChain(chain, tab)).toTop;
            const margin = 4 + 2 * (chain?.links.length ?? 0);

            for (const id of ids) {
                const box = bounds((await modelOf(access, tab, id)).border);
                const mapped = transform === undefined ? box : mapRect(transform, box);

                boxes.push({
                    x     : mapped.x - margin, y     : mapped.y - margin,
                    width : mapped.width + 2 * margin, height: mapped.height + 2 * margin,
                });
            }
        }

        return boxes;
    } catch (error) {
        if (error instanceof ToolError) throw error;

        throw maskError();
    }
}
