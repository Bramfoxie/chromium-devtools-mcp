import type { DaemonAccess } from "../mcp/index.js";
import {
    coveredMessage,
    type ElementState,
    ensureActionable,
    hitTest,
    retryWhileRefused,
    TransientRefusal,
    type ActionWait,
} from "./actionability.js";
import { clickPointOf, type ClickPoint, TOP_LEVEL_ORIGIN } from "./coordinates.js";
import { type ToolContext } from "./define-tool.js";
import { type Measurement, type PointerRoute } from "./pointer-delivery.js";
import { startRendering } from "./hold-rendering.js";
import { frameChain, mapPoint, measureChain, outerHitTest, revealChain } from "./frame-geometry.js";
import { type Rect, elementAccess, revealElement, type ResolvedElement } from "./element-target.js";
import { ToolError } from "./errors.js";

export async function mousePoint(
    context : ToolContext,
    targetId: string,
    element : ResolvedElement,
    position: { x: number; y: number } | undefined,
    verb    : string,
    force   : boolean,
    wait?   : ActionWait,
): Promise<{ point: ClickPoint; state: ElementState; box: Rect; route?: PointerRoute }> {
    return retryWhileRefused(wait, () =>
        mousePointOnce(context, targetId, element, position, verb, force));
}

async function mousePointOnce(
    context : ToolContext,
    targetId: string,
    element : ResolvedElement,
    position: { x: number; y: number } | undefined,
    verb    : string,
    force   : boolean,
): Promise<{ point: ClickPoint; state: ElementState; box: Rect; route?: PointerRoute }> {
    const owner = elementAccess(context.access, element);
    const scrolled = await ensureActionable(owner, targetId, element, {
        checkDisabled: true,
    });
    const local = clickPointOf(scrolled.box, position, TOP_LEVEL_ORIGIN);

    if (element.isolated === true && element.frameId !== undefined) {
        const found = await isolatedPoint(context, targetId, element.frameId, scrolled.box, local, {
            owner,
            element,
            verb,
            force,
            position,
        });

        return { point: found.point, state: scrolled.state, box: scrolled.box, route: found.route };
    }

    if (force) return { point: local, state: scrolled.state, box: scrolled.box };

    const hit = await hitTest(context.access, targetId, element, local);

    if (hit.kind === "covered") throw new TransientRefusal(coveredMessage(hit.by, verb));

    if (hit.kind === "outside") {
        throw new ToolError(
            "The target point lies outside the page viewport. Scroll the page and try again.",
        );
    }

    return { point: local, state: scrolled.state, box: scrolled.box };
}

interface IsolatedRequest {
    owner   : DaemonAccess;
    element : ResolvedElement;
    verb    : string;
    force   : boolean;
    position: { x: number; y: number } | undefined;
}

async function isolatedPoint(
    context : ToolContext,
    targetId: string,
    frameId : string,
    box     : Rect,
    local   : ClickPoint,
    request : IsolatedRequest,
): Promise<{ point: ClickPoint; route?: PointerRoute }> {
    const chain = await frameChain(context.access, context.frames, targetId, frameId);
    const release = chain.links.length === 0
        ? async (): Promise<void> => undefined
        : await startRendering(context.access, targetId);

    try {
        return await measuredPoint(context, targetId, chain, box, local, request, release);
    } catch (error) {
        await release();

        throw error;
    }
}

async function measuredPoint(
    context : ToolContext,
    targetId: string,
    chain   : Awaited<ReturnType<typeof frameChain>>,
    box     : Rect,
    local   : ClickPoint,
    request : IsolatedRequest,
    release : () => Promise<void>,
): Promise<{ point: ClickPoint; route?: PointerRoute }> {
    await revealChain(chain, targetId, box);

    const measured = await measureChain(chain, targetId);
    const point = mapPoint(measured.toTop, local);
    const measure = async (): Promise<Measurement> => {
        const ref = { objectId: request.element.objectId };
        const revealed = await revealElement(request.owner, targetId, ref);

        if (revealed.box === null || !revealed.visible) {
            throw new ToolError("The element is hidden: it has no box on the page. Make it visible and try again.");
        }

        await revealChain(chain, targetId, revealed.box);

        const fresh = await measureChain(chain, targetId);

        const freshLocal = clickPointOf(revealed.box, request.position, TOP_LEVEL_ORIGIN);

        return {
            point: mapPoint(fresh.toTop, freshLocal),
            local: freshLocal,
            boxes: fresh.boxes,
        };
    };
    const route: PointerRoute | undefined = chain.links.length === 0 ? undefined : {
        owner    : request.owner,
        frameId  : request.element.frameId ?? "",
        objectId : request.element.objectId,
        relays   : [context.access, ...chain.links.map((link) => link.access), request.owner],
        links    : chain.links,
        initial  : { point, local, boxes: measured.boxes },
        release,
        measure,
        stillOver: request.force
            ? undefined
            : async () => (await hitTest(request.owner, targetId, request.element, local, true)).kind === "hit",
    };

    if (request.force) return { point, route };

    const inner = await hitTest(request.owner, targetId, request.element, local, true);

    if (inner.kind === "covered") throw new TransientRefusal(coveredMessage(inner.by, request.verb));

    if (inner.kind === "outside") {
        throw new ToolError(
            "The target point lies outside the frame viewport. Scroll the frame and try again.",
        );
    }

    const outer = await outerHitTest(chain, measured, targetId, local);

    if (outer.kind === "covered") throw new TransientRefusal(coveredMessage(outer.by, request.verb));

    if (outer.kind === "outside") {
        throw new ToolError(
            "The target point lies outside the page viewport. Scroll the page and try again.",
        );
    }

    return { point, route };
}
