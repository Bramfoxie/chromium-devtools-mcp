import { z } from "zod";
import type { ClickPoint } from "./coordinates.js";
import { parseEnvelope } from "./cdp-envelope.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { elementTargetSchema, withElement } from "./element-target.js";
import { ToolError } from "./errors.js";
import { changedUrl, navigationOf } from "./input-outcome.js";
import { mousePoint } from "./input-point.js";
import { ensureInsideViewport, ensurePointAllowed, pointSchema } from "./point-target.js";
import { throwIfCancelled } from "./registry.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const STEPS_DEFAULT = 8;

const STEPS_MAX = 50;

const INTERCEPT_WAIT_MS = 300;

const INTERCEPT_POLL_MS = 20;

const DRAG_INTERCEPTED = "Input.dragIntercepted";

const endSchema = z.union([elementTargetSchema, pointSchema]);

type End = z.infer<typeof endSchema>;

const interceptedSchema = z.object({ data: z.record(z.string(), z.unknown()) });

function isPoint(end: End): end is z.infer<typeof pointSchema> {
    return "x" in end;
}

async function resolveEnd(
    context : ToolContext,
    targetId: string,
    end     : End,
    verb    : string,
): Promise<ClickPoint> {
    if (isPoint(end)) {
        await ensureInsideViewport(context, targetId, end);
        await ensurePointAllowed("input_drag", context, targetId, end);

        return { x: end.x, y: end.y };
    }

    return withElement(context, targetId, end, async (element) => {
        const found = await mousePoint(context, targetId, element, undefined, verb, false);

        if (found.route !== undefined) {
            await found.route.release();

            throw new ToolError(
                "input_drag cannot use an element inside a cross-site frame. Pass a point instead.",
            );
        }

        return found.point;
    });
}

interface DragEvents {
    intercepted(): Record<string, unknown> | undefined;
    stop(): Promise<void>;
}

async function watchDrags(context: ToolContext, targetId: string): Promise<DragEvents> {
    let data: Record<string, unknown> | undefined;
    const off = context.access.on("cdp.event", (params) => {
        const envelope = parseEnvelope(params);

        if (envelope?.targetId !== targetId || envelope.event !== DRAG_INTERCEPTED) return;

        const parsed = interceptedSchema.safeParse(envelope.params);

        if (parsed.success) data = parsed.data.data;
    });

    try {
        await context.access.subscribe(targetId, DRAG_INTERCEPTED);
        await context.access.send({
            targetId,
            method: "Input.setInterceptDrags",
            params: { enabled: true },
        });
    } catch (error) {
        off();
        await context.access.unsubscribe(targetId, DRAG_INTERCEPTED).catch(() => undefined);

        throw error;
    }

    return {
        intercepted: () => data,
        stop       : async () => {
            off();
            await context.access.send({
                targetId,
                method: "Input.setInterceptDrags",
                params: { enabled: false },
            }).catch(() => undefined);
            await context.access.unsubscribe(targetId, DRAG_INTERCEPTED).catch(() => undefined);
        },
    };
}

async function mouse(
    context : ToolContext,
    targetId: string,
    type    : "mouseMoved" | "mousePressed" | "mouseReleased",
    at      : ClickPoint,
    held    : boolean,
): Promise<void> {
    await context.access.send({
        targetId,
        method: "Input.dispatchMouseEvent",
        params: {
            type,
            x         : at.x,
            y         : at.y,
            modifiers : 0,
            button    : held || type !== "mouseMoved" ? "left" : "none",
            buttons   : held ? 1 : 0,
            clickCount: type === "mouseMoved" ? 0 : 1,
        },
    });
}

async function waitForIntercept(context: ToolContext, events: DragEvents): Promise<void> {
    for (let waited = 0; waited < INTERCEPT_WAIT_MS; waited += INTERCEPT_POLL_MS) {
        if (events.intercepted() !== undefined) return;

        throwIfCancelled(context.signal);
        await context.clock.sleep(INTERCEPT_POLL_MS);
    }
}

async function dragEvent(
    context : ToolContext,
    targetId: string,
    type    : "dragEnter" | "dragOver" | "drop",
    at      : ClickPoint,
    data    : Record<string, unknown>,
): Promise<void> {
    await context.access.send({
        targetId,
        method: "Input.dispatchDragEvent",
        params: { type, x: at.x, y: at.y, modifiers: 0, data },
    });
}

async function perform(
    context : ToolContext,
    targetId: string,
    from    : ClickPoint,
    to      : ClickPoint,
    steps   : number,
): Promise<"html5" | "pointer"> {
    const events = await watchDrags(context, targetId);
    let pressed = false;

    try {
        await mouse(context, targetId, "mouseMoved", from, false);
        await mouse(context, targetId, "mousePressed", from, true);
        pressed = true;

        for (let step = 1; step <= steps; step += 1) {
            throwIfCancelled(context.signal);

            const at = {
                x: Math.round(from.x + ((to.x - from.x) * step) / steps),
                y: Math.round(from.y + ((to.y - from.y) * step) / steps),
            };

            await mouse(context, targetId, "mouseMoved", at, true);
        }

        await waitForIntercept(context, events);

        const data = events.intercepted();

        if (data !== undefined) {
            await dragEvent(context, targetId, "dragEnter", to, data);
            await dragEvent(context, targetId, "dragOver", to, data);
            await dragEvent(context, targetId, "drop", to, data);
        }

        await mouse(context, targetId, "mouseReleased", to, false);
        pressed = false;

        return data === undefined ? "pointer" : "html5";
    } catch (error) {
        if (pressed) await mouse(context, targetId, "mouseReleased", to, false).catch(() => undefined);

        throw error;
    } finally {
        await events.stop();
    }
}

export const inputDrag = defineTool({
    name: "input_drag",
    description:
        "Drag from one element or viewport point to another and drop there, with trusted CDP mouse events. Works for pointer based drags and for HTML5 drag and drop.",
    access: "mutate",
    input : z.strictObject({
        tab  : tabSchema,
        from : endSchema.describe("Where to press: an element (uid or selector) or a viewport point {x, y} in CSS pixels."),
        to   : endSchema.describe("Where to release: an element (uid or selector) or a viewport point {x, y} in CSS pixels."),
        steps: z.number().int().min(1).max(STEPS_MAX).optional().describe(`Mouse moves between the two ends, 1 to ${STEPS_MAX}. Defaults to ${STEPS_DEFAULT}.`),
    }),
    output: z.strictObject({
        ok      : z.boolean().describe("Whether the mouse events were dispatched."),
        kind    : z.enum(["html5", "pointer"]).describe("html5 when the page started a native drag and received the drop, pointer when it was a plain mouse drag."),
        from    : z.strictObject({ x: z.number(), y: z.number() }).describe("Viewport point where the mouse was pressed."),
        to      : z.strictObject({ x: z.number(), y: z.number() }).describe("Viewport point where the mouse was released."),
        effect  : z.string().describe("Short summary of what happened."),
        urlAfter: z.string().optional().describe("URL after the drag, present only when the page navigated."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        throwIfCancelled(context.signal);

        await ensureNoDialog(context.dialogs, targetId);
        await context.focus.ensure(context.access, targetId);

        const from = await resolveEnd(context, targetId, args.from, "drag from");
        const to = await resolveEnd(context, targetId, args.to, "drop on");
        const steps = args.steps ?? STEPS_DEFAULT;
        const acted = await navigationOf(context.access, targetId, () =>
            perform(context, targetId, from, to, steps));
        const kind = acted.value;

        return {
            ok    : true,
            kind,
            from,
            to,
            effect: kind === "html5"
                ? "The element was dragged and dropped with native drag events."
                : "The mouse was dragged and released; the page received plain mouse events.",
            ...changedUrl(acted.urlBefore, acted.urlAfter),
        };
    },
});
