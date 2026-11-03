import { z } from "zod";
import { ErrorCode, RpcError } from "../daemon/index.js";
import type { DaemonAccess } from "../mcp/index.js";
import type { Rect } from "./element-target.js";
import { ToolError } from "./errors.js";
import { bindAccess } from "./frame-scope.js";
import type { FrameInfo, FrameState } from "./frames.js";

interface FrameTransform {
    x     : number;
    y     : number;
    scaleX: number;
    scaleY: number;
}

export interface Point {
    x: number;
    y: number;
}

export const IDENTITY_TRANSFORM: FrameTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1 };

export function composeTransform(outer: FrameTransform, inner: FrameTransform): FrameTransform {
    return {
        x     : outer.x + inner.x * outer.scaleX,
        y     : outer.y + inner.y * outer.scaleY,
        scaleX: outer.scaleX * inner.scaleX,
        scaleY: outer.scaleY * inner.scaleY,
    };
}

export function mapPoint(transform: FrameTransform, point: Point): Point {
    return {
        x: Math.round(transform.x + point.x * transform.scaleX),
        y: Math.round(transform.y + point.y * transform.scaleY),
    };
}

export function mapRect(transform: FrameTransform, rect: Rect): Rect {
    return {
        x     : Math.round(transform.x + rect.x * transform.scaleX),
        y     : Math.round(transform.y + rect.y * transform.scaleY),
        width : Math.round(rect.width * transform.scaleX),
        height: Math.round(rect.height * transform.scaleY),
    };
}

const quadSchema = z.array(z.number()).length(8).refine((quad) => quad.every(Number.isFinite));
const ownerModelSchema = z.object({
    model: z.object({
        content: quadSchema,
        border : quadSchema,
        width  : z.number(),
        height : z.number(),
    }),
});

interface Bounds {
    left  : number;
    top   : number;
    right : number;
    bottom: number;
}

function boundsOf(quad: number[]): Bounds {
    const xs = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
    const ys = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0];

    return {
        left  : Math.min(...xs),
        top   : Math.min(...ys),
        right : Math.max(...xs),
        bottom: Math.max(...ys),
    };
}

interface OwnerGeometry {
    transform   : FrameTransform;
    borderOffset: Point;
}

export function ownerGeometry(model: z.infer<typeof ownerModelSchema>["model"]): OwnerGeometry {
    const content = boundsOf(model.content);
    const border = boundsOf(model.border);

    return {
        transform: {
            x     : content.left,
            y     : content.top,
            scaleX: model.width > 0 ? (border.right - border.left) / model.width : 1,
            scaleY: model.height > 0 ? (border.bottom - border.top) / model.height : 1,
        },
        borderOffset: { x: content.left - border.left, y: content.top - border.top },
    };
}

export interface FrameLink {
    access       : DaemonAccess;
    backendNodeId: number;
}

interface FrameChain {
    links: FrameLink[];
}

function isCdpError(error: unknown): boolean {
    return error instanceof RpcError && error.code === ErrorCode.cdpError;
}

async function infoOf(frames: FrameState, tab: string, frameId: string): Promise<FrameInfo> {
    return frames.frameOf(tab, frameId) ?? await frames.resolve(tab, frameId);
}

async function sessionFrameOf(
    frames : FrameState,
    tab    : string,
    frameId: string | undefined,
): Promise<string | undefined> {
    let current = frameId;

    while (current !== undefined) {
        const info = await infoOf(frames, tab, current);

        if (info.isolated) return current;

        current = info.parentFrameId;
    }

    return undefined;
}

const frameOwnerSchema = z.object({ backendNodeId: z.number() });
const ownerNodeSchema = z.object({
    node: z.object({ contentDocument: z.unknown().optional() }),
});

async function ownerOf(
    owner  : DaemonAccess,
    tab    : string,
    frameId: string,
): Promise<{ backendNodeId: number; inProcess: boolean }> {
    try {
        const { backendNodeId } = frameOwnerSchema.parse(
            await owner.send(tab, "DOM.getFrameOwner", { frameId }),
        );
        const described = ownerNodeSchema.parse(
            await owner.send(tab, "DOM.describeNode", { backendNodeId, depth: 1, pierce: true }),
        );

        return { backendNodeId, inProcess: described.node.contentDocument !== undefined };
    } catch (error) {
        if (isCdpError(error) || error instanceof z.ZodError) {
            throw new ToolError(
                "The iframe element that holds the frame was not found. Take a new dom_snapshot and try again.",
            );
        }

        throw error;
    }
}

export async function frameChain(
    access : DaemonAccess,
    frames : FrameState,
    tab    : string,
    frameId: string,
): Promise<FrameChain> {
    await frames.refresh(tab).catch(() => undefined);

    const links: FrameLink[] = [];
    let current: string | undefined = frameId;

    while (current !== undefined) {
        const info = await infoOf(frames, tab, current);

        if (!info.isolated || info.parentFrameId === undefined) break;

        const sessionFrame = await sessionFrameOf(frames, tab, info.parentFrameId);
        const owner = sessionFrame === undefined ? access : bindAccess(access, sessionFrame);
        const found = await ownerOf(owner, tab, current);

        if (!found.inProcess) {
            links.push({ access: owner, backendNodeId: found.backendNodeId });
        }

        current = sessionFrame;
    }

    return { links };
}

async function ownerModel(
    link: FrameLink,
    tab : string,
): Promise<OwnerGeometry & { box: Rect }> {
    let result: unknown;

    try {
        result = await link.access.send(tab, "DOM.getBoxModel", { backendNodeId: link.backendNodeId });
    } catch (error) {
        if (isCdpError(error)) {
            throw new ToolError(
                "The iframe that holds the element has no box on the page. Make it visible and try again.",
            );
        }

        throw error;
    }

    const parsed = ownerModelSchema.safeParse(result);

    if (!parsed.success) {
        throw new ToolError(
            "The browser sent an unexpected response to DOM.getBoxModel. Try the call again.",
        );
    }

    const border = boundsOf(parsed.data.model.border);

    return {
        ...ownerGeometry(parsed.data.model),
        box: {
            x     : Math.round(border.left),
            y     : Math.round(border.top),
            width : Math.round(border.right - border.left),
            height: Math.round(border.bottom - border.top),
        },
    };
}

interface MeasuredChain {
    steps: FrameTransform[];
    boxes: Rect[];
    toTop: FrameTransform;
}

export async function measureChain(chain: FrameChain, tab: string): Promise<MeasuredChain> {
    const steps: FrameTransform[] = [];
    const boxes: Rect[] = [];

    for (const link of chain.links) {
        const model = await ownerModel(link, tab);

        steps.push(model.transform);
        boxes.push(model.box);
    }

    return {
        steps,
        boxes,
        toTop: steps.reduceRight(
            (outer, inner) => composeTransform(outer, inner),
            IDENTITY_TRANSFORM,
        ),
    };
}

export async function revealChain(chain: FrameChain, tab: string, rect: Rect): Promise<void> {
    let current = rect;

    for (const link of chain.links) {
        const before = await ownerModel(link, tab);
        const inBorder = {
            x     : current.x * before.transform.scaleX + before.borderOffset.x,
            y     : current.y * before.transform.scaleY + before.borderOffset.y,
            width : current.width * before.transform.scaleX,
            height: current.height * before.transform.scaleY,
        };

        try {
            await link.access.send(tab, "DOM.scrollIntoViewIfNeeded", {
                backendNodeId: link.backendNodeId,
                rect         : inBorder,
            });
        } catch (error) {
            if (isCdpError(error)) {
                throw new ToolError(
                    "The iframe that holds the element is not visible on the page and cannot be scrolled into view.",
                );
            }

            throw error;
        }

        current = mapRect((await ownerModel(link, tab)).transform, current);
    }
}

const SETTLE_EXPRESSION = `new Promise((resolve) => {
  const timer = setTimeout(resolve, 150);
  requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(true); }));
})`;

export async function settleRendering(accesses: DaemonAccess[], tab: string): Promise<void> {
    for (const access of accesses) {
        await access.send(tab, "Runtime.evaluate", {
            expression   : SETTLE_EXPRESSION,
            awaitPromise : true,
            returnByValue: true,
        }).catch(() => undefined);
    }
}

const COVER_EXPRESSION = `function (x, y) {
  const doc = this.ownerDocument;
  const el = doc.elementFromPoint(x, y);
  if (el === null) return { kind: "outside" };
  if (el === this || this.contains(el)) return { kind: "hit" };
  return { kind: "covered", tag: el.localName, id: el.id, classes: [...el.classList].slice(0, 10) };
}`;

const coverSchema = z.object({
    result: z.object({
        value: z.object({
            kind   : z.enum(["hit", "covered", "outside"]),
            tag    : z.string().optional(),
            id     : z.string().optional(),
            classes: z.array(z.string()).optional(),
        }).optional(),
    }),
});

type OuterHit =
    | { kind: "hit" }
    | { kind: "outside" }
    | { kind: "covered"; by: { tag: string; id: string; classes: string[] } };

export async function outerHitTest(
    chain   : FrameChain,
    measured: MeasuredChain,
    tab     : string,
    point   : Point,
): Promise<OuterHit> {
    let current = point;

    for (const [index, link] of chain.links.entries()) {
        const step = measured.steps[index];

        if (step === undefined) break;

        current = mapPoint(step, current);

        const resolved = await link.access.send(tab, "DOM.resolveNode", {
            backendNodeId: link.backendNodeId,
        }) as { object?: { objectId?: string } } | null;
        const objectId = resolved?.object?.objectId;

        if (objectId === undefined) continue;

        const parsed = coverSchema.safeParse(
            await link.access.send(tab, "Runtime.callFunctionOn", {
                functionDeclaration: COVER_EXPRESSION,
                objectId,
                arguments          : [{ value: current.x }, { value: current.y }],
                returnByValue      : true,
            }),
        );
        const value = parsed.success ? parsed.data.result.value : undefined;

        if (value === undefined || value.kind === "hit") continue;

        if (value.kind === "outside") return { kind: "outside" };

        return {
            kind: "covered",
            by  : { tag: value.tag ?? "?", id: value.id ?? "", classes: value.classes ?? [] },
        };
    }

    return { kind: "hit" };
}
