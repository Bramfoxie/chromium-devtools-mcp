import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import type { ToolContext } from "./define-tool.js";
import { elementAccess, withElement, type ElementTarget } from "./element-target.js";
import { mainFrameId } from "./page-navigate-state.js";
import { releaseQuietly } from "./remote-objects.js";
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
    return new ToolError("Screenshot masking could not cover the image. Retry without masking only if the image can be shared safely.");
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

const selectedBoundsSchema = z.object({
    result: z.object({ value: z.object({
        x     : z.number().finite(), y     : z.number().finite(),
        width : z.number().finite().nonnegative(), height: z.number().finite().nonnegative(),
        self  : z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
    }).optional() }),
    exceptionDetails: z.unknown().optional(),
});

const SELECTED_BOUNDS = `function() {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const roots = [this];
  let visited = 0;
  const add = (rect) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    left = Math.min(left, rect.left); top = Math.min(top, rect.top);
    right = Math.max(right, rect.right); bottom = Math.max(bottom, rect.bottom);
  };
  const visit = (node) => {
    if (++visited > 5000) throw new Error("Too many elements to mask");
    add(Element.prototype.getBoundingClientRect.call(node));
    if (node.shadowRoot) roots.push(node.shadowRoot);
  };
  while (roots.length) {
    const root = roots.pop();
    if (root.nodeType === Node.ELEMENT_NODE) visit(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) visit(walker.currentNode);
    const range = document.createRange();
    range.selectNodeContents(root);
    add(range.getBoundingClientRect());
  }
  if (!Number.isFinite(left)) throw new Error("No visible bounds");
  const self = Element.prototype.getBoundingClientRect.call(this);
  return { x: left, y: top, width: right - left, height: bottom - top,
    self: { x: self.x, y: self.y, width: self.width, height: self.height } };
}`;

const descendantSnapshotSchema = z.object({
    strings  : z.array(z.string()),
    documents: z.array(z.object({
        frameId      : z.number().int().nonnegative(),
        scrollOffsetX: z.number().optional(), scrollOffsetY: z.number().optional(),
        nodes        : z.object({
            backendNodeId: z.array(z.number()), parentIndex: z.array(z.number()),
        }),
        layout: z.object({
            nodeIndex: z.array(z.number()), bounds: z.array(z.array(z.number()).length(4)),
        }),
    })),
});

async function readDescendantSnapshot(access: DaemonAccess, tab: string) {
    const snapshot = descendantSnapshotSchema.safeParse(await access.send({
        targetId : tab, method   : "DOMSnapshot.captureSnapshot", params   : { computedStyles: [] },
        timeoutMs: 5000,
    }));

    if (!snapshot.success) throw maskError();

    return snapshot.data;
}

function descendantBounds(
    snapshot: z.infer<typeof descendantSnapshotSchema>, backendNodeId: number,
): Rect[] {
    for (const doc of snapshot.documents) {
        const root = doc.nodes.backendNodeId.indexOf(backendNodeId);

        if (root < 0) continue;

        const parents = doc.nodes.parentIndex;

        if (parents.length !== doc.nodes.backendNodeId.length || parents.length > 50000 ||
            doc.layout.nodeIndex.length !== doc.layout.bounds.length) throw maskError();

        const included = new Set<number>([root]);

        for (let i = root + 1; i < parents.length; i += 1) {
            const parent = parents[i];

            if (parent === undefined || parent >= i) throw maskError();
            if (included.has(parent)) included.add(i);
        }

        const boxes: Rect[] = [];

        for (let i = 0; i < doc.layout.nodeIndex.length; i += 1) {
            const index = doc.layout.nodeIndex[i];
            const rect = doc.layout.bounds[i];

            if (index === undefined || rect === undefined || index < 0 || index >= parents.length) {
                throw maskError();
            }

            if (!included.has(index)) continue;

            const [x, y, width, height] = rect;

            if (x === undefined || y === undefined || width === undefined || height === undefined ||
                ![x, y, width, height].every(Number.isFinite)) throw maskError();
            if (width <= 0 || height <= 0) continue;

            boxes.push({
                x: x - (doc.scrollOffsetX ?? 0), y: y - (doc.scrollOffsetY ?? 0), width, height,
            });
        }

        return boxes;
    }

    throw maskError();
}

async function selectedBounds(
    access: DaemonAccess, tab: string, backendNodeId: number, frameId: string,
): Promise<Rect & { self: Rect }> {
    const world = z.object({ executionContextId: z.number() }).safeParse(await access.send({
        targetId: tab, method  : "Page.createIsolatedWorld",
        params  : { frameId, worldName: "chromium-devtools-mcp-mask" },
    }));

    if (!world.success) throw maskError();

    const resolved = z.object({ object: z.object({ objectId: z.string() }) }).safeParse(
        await access.send({
            targetId: tab, method  : "DOM.resolveNode",
            params  : { backendNodeId, executionContextId: world.data.executionContextId },
        }),
    );

    if (!resolved.success) throw maskError();

    const objectId = resolved.data.object.objectId;

    try {
        const parsed = selectedBoundsSchema.safeParse(await access.send({
            targetId: tab,
            method  : "Runtime.callFunctionOn",
            params  : { objectId, functionDeclaration: SELECTED_BOUNDS, returnByValue: true },
        }));

        if (!parsed.success || parsed.data.exceptionDetails !== undefined ||
            parsed.data.result.value === undefined) throw maskError();

        return parsed.data.result.value;
    } finally {
        await releaseQuietly(access, tab, [objectId]);
    }
}

async function assertUnscaledFrames(
    context: ToolContext, tab: string, frame: string, main: string,
) {
    const frames = await context.frames.refresh(tab);
    let current = frame;
    const visited = new Set<string>();
    const quad = z.array(z.number()).length(8);
    const schema = z.object({ model: z.object({
        border: quad, content: quad, width: z.number(), height: z.number(),
    }) });

    while (current !== main) {
        if (visited.has(current) || visited.size >= 10) throw maskError();

        visited.add(current);
        const info = frames.find((item) => item.frameId === current);

        if (info === undefined || info.isolated ||
            info.parentFrameId === undefined || info.truncated) {
            throw maskError();
        }

        const owner = z.object({ backendNodeId: z.number() }).safeParse(await context.access.send({
            targetId: tab, method: "DOM.getFrameOwner", params: { frameId: current },
        }));

        if (!owner.success) throw maskError();

        const model = schema.safeParse(await context.access.send({
            targetId: tab, method: "DOM.getBoxModel", params: { backendNodeId: owner.data.backendNodeId },
        }));

        if (!model.success) throw maskError();

        const { border, content, width, height } = model.data.model;
        const b = bounds(border);
        const q = (a: number, b: number) => Math.abs(a - b) < 1e-6;
        const aligned = (v: number[]) => q(v[1] ?? 0, v[3] ?? 0) && q(v[5] ?? 0, v[7] ?? 0) &&
            q(v[0] ?? 0, v[6] ?? 0) && q(v[2] ?? 0, v[4] ?? 0);

        if (!aligned(border) || !aligned(content) || width < 1 || height < 1 ||
            Math.abs(b.width / width - 1) > 1e-6 || Math.abs(b.height / height - 1) > 1e-6) {
            throw maskError();
        }

        current = info.parentFrameId;
    }
}

export async function selectedBoxes(
    context: ToolContext, tab: string, targets: readonly ElementTarget[],
): Promise<Rect[]> {
    const boxes: Rect[] = [];
    const snapshots = new Map<string, Promise<z.infer<typeof descendantSnapshotSchema>>>();

    for (const target of targets) {
        const box = await withElement(context, tab, target, async (element) => {
            const owner = elementAccess(context.access, element);
            const parsed = boxSchema.safeParse(await owner.send({
                targetId: tab, method: "DOM.getBoxModel", params: { objectId: element.objectId },
            }));

            if (!parsed.success) throw maskError();

            const border = bounds(parsed.data.model.border);
            const main = await mainFrameId(context, tab);
            const sessionKey = element.isolated === true ? element.frameId : "top";

            if (main === undefined || sessionKey === undefined) throw maskError();

            let pendingSnapshot = snapshots.get(sessionKey);

            if (pendingSnapshot === undefined) {
                pendingSnapshot = readDescendantSnapshot(owner, tab);
                snapshots.set(sessionKey, pendingSnapshot);
            }

            const snapshot = await pendingSnapshot;
            const doc = snapshot.documents.find(
                (item) => item.nodes.backendNodeId.includes(element.backendNodeId),
            );
            const frame = doc === undefined ? undefined : snapshot.strings[doc.frameId];

            if (frame === undefined ||
                (element.frameId !== undefined && element.frameId !== frame)) {
                throw maskError();
            }

            const extent = await selectedBounds(owner, tab, element.backendNodeId, frame);
            const descendants = descendantBounds(snapshot, element.backendNodeId);
            let measured = [extent, ...descendants];

            if (frame !== main && element.isolated !== true) {
                await assertUnscaledFrames(context, tab, frame, main);
                if (!axisAligned(parsed.data.model.border) ||
                    extent.self.width < 1 || extent.self.height < 1 ||
                    Math.abs(border.width / extent.self.width - 1) > 1e-6 ||
                    Math.abs(border.height / extent.self.height - 1) > 1e-6) throw maskError();

                const dx = border.x - extent.self.x;
                const dy = border.y - extent.self.y;

                measured = measured.map((box) => ({ ...box, x: box.x + dx, y: box.y + dy }));
            }

            const all = [border, ...measured];
            const left = Math.min(...all.map((box) => box.x));
            const top = Math.min(...all.map((box) => box.y));
            const right = Math.max(...all.map((box) => box.x + box.width));
            const bottom = Math.max(...all.map((box) => box.y + box.height));
            const combined = { x: left, y: top, width: right - left, height: bottom - top };

            if (border.width <= 0 || border.height <= 0) {
                throw new ToolError("The selected element has no visible box to mask.");
            }

            const chain = element.isolated === true && element.frameId !== undefined
                ? await frameChain(context.access, context.frames, tab, element.frameId)
                : undefined;

            if (chain !== undefined) {
                if (chain.links.length === 0) throw maskError();

                for (const link of chain.links) {
                    const model = await modelOf(link.access, tab, link.backendNodeId);

                    if (model.content === undefined || !axisAligned(model.content) ||
                        !axisAligned(model.border)) throw maskError();
                }
            }

            const mapped = chain === undefined
                ? combined : mapRect((await measureChain(chain, tab)).toTop, combined);
            const margin = 4 + 2 * (chain?.links.length ?? 0);

            return {
                x     : mapped.x - margin, y     : mapped.y - margin,
                width : mapped.width + 2 * margin, height: mapped.height + 2 * margin,
            };
        });

        boxes.push(box);
    }

    return boxes;
}
