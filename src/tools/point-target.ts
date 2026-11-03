import { z } from "zod";
import { isRestricted } from "../safety/index.js";
import type { ClickPoint } from "./coordinates.js";
import type { ToolContext } from "./define-tool.js";
import { ToolError } from "./errors.js";
import { checkSafety } from "./safety.js";

const POINT_READ_TIMEOUT_MS = 5000;

export const pointSchema = z.strictObject({
    x: z.number().min(0).describe("CSS pixels from the left edge of the viewport."),
    y: z.number().min(0).describe("CSS pixels from the top edge of the viewport."),
});

const layoutSchema = z.object({
    cssLayoutViewport: z.object({ clientWidth: z.number(), clientHeight: z.number() }).optional(),
    layoutViewport   : z.object({ clientWidth: z.number(), clientHeight: z.number() }).optional(),
});

const pointedSchema = z.object({
    result: z.object({
        value: z.object({
            tag    : z.string(),
            id     : z.string(),
            classes: z.array(z.string()),
        }).nullable().optional(),
    }),
});

const nodeAtSchema = z.object({
    backendNodeId: z.number(),
    frameId      : z.string().optional(),
});

const describedSchema = z.object({
    node: z.object({ frameId: z.string().optional() }),
});

export interface PointedElement {
    tag    : string;
    id?    : string;
    classes: string[];
}

function elementAtExpression(point: ClickPoint): string {
    return `(() => {
  const element = document.elementFromPoint(${point.x}, ${point.y});
  if (!element) return null;
  return { tag: element.localName, id: element.id, classes: [...element.classList].slice(0, 10) };
})()`;
}

export async function ensureInsideViewport(
    context : ToolContext,
    targetId: string,
    point   : ClickPoint,
): Promise<void> {
    const metrics = layoutSchema.safeParse(
        await context.access.send({
            targetId,
            method   : "Page.getLayoutMetrics",
            timeoutMs: POINT_READ_TIMEOUT_MS,
        }),
    );
    const viewport = metrics.success
        ? (metrics.data.cssLayoutViewport ?? metrics.data.layoutViewport)
        : undefined;

    if (viewport === undefined) {
        throw new ToolError("The viewport size could not be read. Try the call again.");
    }

    if (point.x >= viewport.clientWidth || point.y >= viewport.clientHeight) {
        throw new ToolError(
            `The point (${point.x}, ${point.y}) lies outside the viewport of ${viewport.clientWidth} by ${viewport.clientHeight} CSS pixels. Scroll the page or take a new screenshot and pick a point inside it.`,
        );
    }
}

export async function elementAtPoint(
    context : ToolContext,
    targetId: string,
    point   : ClickPoint,
): Promise<PointedElement | undefined> {
    const parsed = pointedSchema.safeParse(
        await context.access.send({
            targetId,
            method   : "Runtime.evaluate",
            params   : { expression: elementAtExpression(point), returnByValue: true },
            timeoutMs: POINT_READ_TIMEOUT_MS,
        }),
    );
    const value = parsed.success ? parsed.data.result.value : undefined;

    if (value === undefined || value === null) return undefined;

    return {
        tag    : value.tag,
        ...(value.id === "" ? {} : { id: value.id }),
        classes: value.classes,
    };
}

function unverifiable(): ToolError {
    return new ToolError(
        "The frame under the point could not be checked against safety.allowedDomains. Call the tool again.",
    );
}

// With an allowlist, refuses a point that lands inside a frame from another origin.
export async function ensurePointAllowed(
    tool    : string,
    context : ToolContext,
    targetId: string,
    point   : ClickPoint,
): Promise<void> {
    if (!isRestricted(context.config.safety.allowedDomains)) return;

    let frameId: string | undefined;

    try {
        const hit = nodeAtSchema.safeParse(
            await context.access.send({
                targetId,
                method   : "DOM.getNodeForLocation",
                params   : { x: Math.floor(point.x), y: Math.floor(point.y) },
                timeoutMs: POINT_READ_TIMEOUT_MS,
            }),
        );

        if (!hit.success) throw unverifiable();

        const described = describedSchema.safeParse(
            await context.access.send({
                targetId,
                method   : "DOM.describeNode",
                params   : { backendNodeId: hit.data.backendNodeId },
                timeoutMs: POINT_READ_TIMEOUT_MS,
            }),
        );

        frameId = (described.success ? described.data.node.frameId : undefined) ?? hit.data.frameId;
    } catch (error) {
        if (error instanceof ToolError) throw error;

        if (/no node found/i.test(error instanceof Error ? error.message : "")) return;

        throw unverifiable();
    }

    if (frameId === undefined) return;

    try {
        if (!context.frames.ensured(targetId)) await context.frames.ensure(targetId);
    } catch {
        throw unverifiable();
    }

    if (frameId === context.frames.mainFrame(targetId)) return;

    const info = context.frames.frameOf(targetId, frameId);

    if (info === undefined) throw unverifiable();

    let origin: string | undefined;

    try {
        const parsed = new URL(info.url).origin;

        origin = parsed === "null" ? undefined : parsed;
    } catch {
        origin = undefined;
    }

    const decision = checkSafety({
        tool,
        access: "mutate",
        config: context.config,
        frame : {
            frameId: info.frameId,
            url    : info.url,
            ...(origin === undefined ? {} : { origin }),
        },
    });

    if (!decision.allowed) throw new ToolError(`${decision.reason} ${decision.hint}`);
}
