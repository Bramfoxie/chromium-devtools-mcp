import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { ensureActionable } from "./actionability.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import {
    boxOf,
    elementAccess,
    elementTargetSchema,
    type ElementTarget,
    resolveElement,
    type ResolvedElement,
} from "./element-target.js";
import { ToolError } from "./errors.js";
import { frameChain, revealChain } from "./frame-geometry.js";
import { summarizeTarget, targetSummarySchema } from "./input-click.js";
import { throwIfCancelled } from "./registry.js";

export const SCROLL_DELTA_MAX = 20000;

export const WHEEL_SETTLE_MS = 350;

export const EDGE_WHEEL_LIMIT = 50;

export const EDGE_STALL_MS = 5000;

export const SCROLL_BLOCKS = ["start", "center", "end", "nearest"] as const;

export type ScrollBlock = (typeof SCROLL_BLOCKS)[number];

export const SCROLL_EDGES = ["top", "bottom"] as const;

export type ScrollEdge = (typeof SCROLL_EDGES)[number];

export interface ScrollPosition {
    x     : number;
    y     : number;
    maxX  : number;
    maxY  : number;
    width : number;
    height: number;
}

export const SCROLL_STATE_EXPRESSION = `(() => ({
  x: Math.round(window.scrollX),
  y: Math.round(window.scrollY),
  maxX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
  maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  width: window.innerWidth,
  height: window.innerHeight,
}))()`;

const scrollStateSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.object({
            x     : z.number(),
            y     : z.number(),
            maxX  : z.number(),
            maxY  : z.number(),
            width : z.number(),
            height: z.number(),
        }).optional(),
    }),
});

async function scrollState(access: DaemonAccess, tab: string): Promise<ScrollPosition> {
    const parsed = scrollStateSchema.safeParse(
        await access.send(tab, "Runtime.evaluate", {
            expression   : SCROLL_STATE_EXPRESSION,
            returnByValue: true,
        }),
    );

    if (!parsed.success || parsed.data.result.value === undefined) {
        throw new ToolError(
            "The browser sent an unexpected response to Runtime.evaluate. Try the call again.",
        );
    }

    return parsed.data.result.value;
}

export function wheelParams(
    point : { x: number; y: number },
    deltaX: number,
    deltaY: number,
): Record<string, unknown> {
    return {
        type      : "mouseWheel",
        x         : point.x,
        y         : point.y,
        modifiers : 0,
        button    : "none",
        buttons   : 0,
        clickCount: 0,
        deltaX,
        deltaY,
    };
}

export interface WheelScrollResult {
    position: ScrollPosition;
    method  : "wheel";
}

export function scrollMoved(before: ScrollPosition, after: ScrollPosition): boolean {
    return after.x !== before.x || after.y !== before.y;
}

async function wheelScroll(
    context : ToolContext,
    targetId: string,
    before  : ScrollPosition,
    point   : { x: number; y: number },
    deltaX  : number,
    deltaY  : number,
): Promise<WheelScrollResult> {
    await context.access.send(targetId, "Input.dispatchMouseEvent", wheelParams(point, deltaX, deltaY));

    const after = await settleScroll(context, targetId);

    return { position: after, method: "wheel" };
}

async function settleScroll(context: ToolContext, targetId: string): Promise<ScrollPosition> {
    let current = await scrollState(context.access, targetId);

    for (let round = 0; round < 5; round += 1) {
        await context.clock.sleep(WHEEL_SETTLE_MS);
        throwIfCancelled(context.signal);

        const next = await scrollState(context.access, targetId);

        if (!scrollMoved(current, next)) return next;

        current = next;
    }

    return current;
}

async function awaitLateScroll(
    context : ToolContext,
    targetId: string,
    from    : ScrollPosition,
): Promise<ScrollPosition> {
    const deadline = context.clock.now() + EDGE_STALL_MS;
    let latest = from;

    while (context.clock.now() < deadline) {
        await context.clock.sleep(WHEEL_SETTLE_MS);
        throwIfCancelled(context.signal);
        latest = await scrollState(context.access, targetId);

        if (scrollMoved(from, latest)) return settleScroll(context, targetId);
    }

    return latest;
}

export const inputScroll = defineTool({
    name: "input_scroll",
    description:
        "Scroll the page by wheel deltas, to an edge, or an element into view, with trusted wheel events.",
    access: "mutate",
    input : z.strictObject({
        tab   : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        target: elementTargetSchema.optional().describe("Element uid from a snapshot or query, or a CSS selector. Scrolls it into view; combine with block."),
        block : z.enum(SCROLL_BLOCKS).optional().describe("Vertical alignment inside the viewport when scrolling to an element. Defaults to center."),
        deltaX: z.number().int().min(-SCROLL_DELTA_MAX).max(SCROLL_DELTA_MAX).optional().describe("Horizontal pixels to scroll, negative scrolls left."),
        deltaY: z.number().int().min(-SCROLL_DELTA_MAX).max(SCROLL_DELTA_MAX).optional().describe("Vertical pixels to scroll, negative scrolls up."),
        at    : z.strictObject({
            x: z.number().describe("Viewport X in CSS pixels where the wheel turns."),
            y: z.number().describe("Viewport Y in CSS pixels where the wheel turns."),
        }).optional().describe("Point where the wheel turns. Defaults to the viewport center."),
        to: z.enum(SCROLL_EDGES).optional().describe("Scroll to the top or the bottom of the page."),
    }).superRefine((value, ctx) => {
        const modes = [
            value.target !== undefined,
            value.deltaX !== undefined || value.deltaY !== undefined,
            value.to !== undefined,
        ].filter(Boolean).length;

        if (modes !== 1) {
            ctx.addIssue({
                code   : "custom",
                message: "Provide exactly one of target, deltaX/deltaY or to.",
            });
        }

        if (value.block !== undefined && value.target === undefined) {
            ctx.addIssue({ code: "custom", message: "block needs a target to scroll to." });
        }

        if (value.at !== undefined && value.deltaX === undefined && value.deltaY === undefined) {
            ctx.addIssue({ code: "custom", message: "at needs deltaX or deltaY to scroll by." });
        }
    }),
    output: z.strictObject({
        ok    : z.boolean().describe("Whether the scroll ran."),
        target: targetSummarySchema.optional().describe("The element scrolled into view, when a target was given."),
        effect: z.string().describe("Short summary of what happened."),
        method: z.enum(["wheel", "intoView"]).describe("How the page was scrolled: trusted wheel events or scrollIntoView for an element."),
        x     : z.number().describe("Horizontal scroll position after the scroll."),
        y     : z.number().describe("Vertical scroll position after the scroll."),
        maxX  : z.number().describe("Maximum horizontal scroll position."),
        maxY  : z.number().describe("Maximum vertical scroll position."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        throwIfCancelled(context.signal);

        await ensureNoDialog(context.dialogs, targetId);
        await context.focus.ensure(context.access, targetId);

        if (args.target !== undefined) {
            return scrollToElement(context, targetId, args.target, args.block ?? "center");
        }

        const state = await scrollState(context.access, targetId);

        if (args.at !== undefined && !insideViewport(args.at, state)) {
            throw new ToolError(
                `The point (${args.at.x}, ${args.at.y}) is outside the viewport of ${state.width}x${state.height}. Choose a point inside it or omit at.`,
            );
        }

        const point = args.at ?? {
            x: Math.round(state.width / 2),
            y: Math.round(state.height / 2),
        };

        if (args.to !== undefined) {
            return scrollToEdge(context, targetId, state, point, args.to);
        }

        const deltaX = args.deltaX ?? 0;
        const deltaY = args.deltaY ?? 0;

        throwIfCancelled(context.signal);
        const scrolled = await wheelScroll(context, targetId, state, point, deltaX, deltaY);

        const moved = scrollMoved(state, scrolled.position);

        return {
            ok    : true,
            effect: moved
                ? `The page was scrolled by (${deltaX}, ${deltaY}).`
                : `The wheel event was sent by (${deltaX}, ${deltaY}) but the window did not move. A scrollable container under the point may have scrolled, or the page is at its edge.`,
            method: scrolled.method,
            x     : scrolled.position.x,
            y     : scrolled.position.y,
            maxX  : scrolled.position.maxX,
            maxY  : scrolled.position.maxY,
        };
    },
});

export const SCROLL_INTO_VIEW_EXPRESSION = "function (element, block) { element.scrollIntoView({ block: String(block), inline: \"nearest\" }); }";

async function scrollToElement(
    context : ToolContext,
    targetId: string,
    target  : ElementTarget,
    block   : ScrollBlock,
): Promise<{
    ok    : boolean;
    target: ReturnType<typeof summarizeTarget>;
    effect: string;
    method: "intoView";
    x     : number;
    y     : number;
    maxX  : number;
    maxY  : number;
}> {
    const element: ResolvedElement = await resolveElement(
        context.access,
        context.elements,
        targetId,
        target,
        { frames: context.frames, allowIsolated: true },
    );
    const owner = elementAccess(context.access, element);
    const checked = await ensureActionable(owner, targetId, element, {
        checkDisabled: false,
    });

    await owner.send(targetId, "Runtime.callFunctionOn", {
        functionDeclaration: SCROLL_INTO_VIEW_EXPRESSION,
        objectId           : element.objectId,
        arguments          : [{ objectId: element.objectId }, { value: block }],
        returnByValue      : true,
    });

    if (element.isolated === true && element.frameId !== undefined) {
        const placed = await boxOf(owner, targetId, { objectId: element.objectId });

        if (placed.box !== null) {
            await revealChain(
                await frameChain(context.access, context.frames, targetId, element.frameId),
                targetId,
                placed.box,
            );
        }
    }

    const after = await scrollState(owner, targetId);

    return {
        ok    : true,
        target: summarizeTarget(target.uid, checked.state),
        effect: "The element was scrolled into view.",
        method: "intoView",
        x     : after.x,
        y     : after.y,
        maxX  : after.maxX,
        maxY  : after.maxY,
    };
}

async function scrollToEdge(
    context : ToolContext,
    targetId: string,
    before  : ScrollPosition,
    point   : { x: number; y: number },
    to      : ScrollEdge,
): Promise<{
    ok    : boolean;
    effect: string;
    method: "wheel";
    x     : number;
    y     : number;
    maxX  : number;
    maxY  : number;
}> {
    const atEdge = (position: ScrollPosition): boolean =>
        to === "top" ? position.y <= 0 : position.y >= position.maxY;
    let current = before;
    const method = "wheel" as const;

    for (let wheel = 0; wheel < EDGE_WHEEL_LIMIT && !atEdge(current); wheel += 1) {
        const remaining = to === "top" ? -current.y : current.maxY - current.y;
        const delta = clampDelta(remaining);
        const scrolled = await wheelScroll(context, targetId, current, point, 0, delta);
        const settled = scrollMoved(current, scrolled.position)
            ? scrolled.position
            : await awaitLateScroll(context, targetId, scrolled.position);
        const progressed = scrollMoved(current, settled);

        current = settled;

        if (!progressed) break;
    }

    const reached = atEdge(current);
    const edge = to === "top" ? "top" : "bottom";

    return {
        ok    : reached,
        effect: reached
            ? `The page was scrolled to the ${edge}.`
            : `The page stopped at y=${current.y} of ${current.maxY} before reaching the ${edge}.`,
        method,
        x   : current.x,
        y   : current.y,
        maxX: current.maxX,
        maxY: current.maxY,
    };
}

function insideViewport(point: { x: number; y: number }, state: ScrollPosition): boolean {
    return point.x >= 0 && point.y >= 0 && point.x < state.width && point.y < state.height;
}

function clampDelta(delta: number): number {
    return Math.max(-SCROLL_DELTA_MAX, Math.min(SCROLL_DELTA_MAX, Math.round(delta)));
}
