import { z } from "zod";
import { changedUrl, navigationOf, summarizeTarget, targetSummarySchema } from "./input-outcome.js";
import { mousePoint } from "./input-point.js";
import { ensureActionable } from "./actionability.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { type PointerRoute, type PointerTarget, withPointerDelivery } from "./pointer-delivery.js";
import type { ClickPoint } from "./coordinates.js";
import { elementTargetSchema, elementAccess, withElement } from "./element-target.js";
import { ToolError } from "./errors.js";
import { KEY_MODIFIERS, modifiersMask } from "./keys.js";
import { throwIfCancelled } from "./registry.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const CLICK_EXPRESSION = `function (element, scroll) {
  if (scroll) element.scrollIntoView({ block: "center", inline: "center" });
  element.click();
  return "clicked";
}`;

const clickResultSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.unknown().optional(),
    }).optional(),
    exceptionDetails: z.unknown().optional(),
});

const MOUSE_BUTTONS = ["left", "middle", "right"] as const;

type MouseButton = (typeof MOUSE_BUTTONS)[number];

const MOUSE_BUTTON_BIT: Record<MouseButton, number> = {
    left  : 1,
    middle: 4,
    right : 2,
};

const CLICK_COUNT_MAX = 3;

const HOVER_DEFAULT_STEPS = 2;

const positionSchema = z.strictObject({
    x: z.number().describe("Offset in CSS pixels from the left edge of the element."),
    y: z.number().describe("Offset in CSS pixels from the top edge of the element."),
});

export const click = defineTool({
    name: "click",
    description:
        "Click an element at the DOM level with element.click() semantics, without moving the mouse.",
    access: "mutate",
    input : z.strictObject({
        tab           : tabSchema,
        target        : elementTargetSchema.describe("Element uid from a snapshot or query, or a CSS selector."),
        scrollIntoView: z.boolean().optional().describe("Scroll the element into view first. Defaults to true."),
    }),
    output: z.strictObject({
        ok      : z.boolean().describe("Whether the click handler ran without exception."),
        target  : targetSummarySchema.describe("The element that was clicked."),
        effect  : z.string().describe("Short summary of what happened."),
        urlAfter: z.string().optional().describe("URL after the click, present only when the click navigated."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        throwIfCancelled(context.signal);

        await ensureNoDialog(context.dialogs, targetId);

        return withElement(context, targetId, args.target, async (element) => {
            const owner = elementAccess(context.access, element);
            const checked = await ensureActionable(owner, targetId, element, {
                checkDisabled: true,
            });
            const uid = args.target.uid;

            if (checked.state.fileInput) {
                throw new ToolError(
                    "The element is a file input: a scripted click would open a file picker and block. Use input_upload instead.",
                );
            }

            const scroll = args.scrollIntoView ?? true;
            const acted = await navigationOf(context.access, targetId, () =>
                owner.send({
                    targetId,
                    method: "Runtime.callFunctionOn",
                    params: {
                        functionDeclaration: CLICK_EXPRESSION,
                        objectId           : element.objectId,
                        arguments          : [{ objectId: element.objectId }, { value: scroll }],
                        returnByValue      : true,
                    },
                }));

            const parsed = clickResultSchema.safeParse(acted.value);

            if (!parsed.success) {
                throw new ToolError(
                    "The browser sent an unexpected response to Runtime.callFunctionOn. Try the call again.",
                );
            }

            const ok = parsed.data.exceptionDetails === undefined;

            return {
                ok,
                target: summarizeTarget(uid, checked.state),
                effect: ok ? "The element was clicked." : "The click handler threw an exception.",
                ...changedUrl(acted.urlBefore, acted.urlAfter),
            };
        });
    },
});

interface ClickPlan {
    button    : MouseButton;
    clickCount: number;
    modifiers : Array<(typeof KEY_MODIFIERS)[number]>;
}

function dispatchClick(
    context : ToolContext,
    targetId: string,
    route   : PointerRoute | undefined,
    point   : ClickPoint,
    plan    : ClickPlan,
) {
    const { button, clickCount } = plan;
    const modifiers = modifiersMask(plan.modifiers);
    const buttons = MOUSE_BUTTON_BIT[button];

    const dispatcher = (target: PointerTarget) =>
        target.via === "frame" && route !== undefined ? route.owner : context.access;

    const sendMove = async (at: PointerTarget): Promise<void> => {
        await dispatcher(at).send({
            targetId,
            method: "Input.dispatchMouseEvent",
            params: {
                type      : "mouseMoved",
                x         : at.point.x,
                y         : at.point.y,
                modifiers,
                button,
                buttons   : 0,
                clickCount: 0,
            },
        });
    };

    return withPointerDelivery(route, targetId, context, (delivery) =>
        navigationOf(context.access, targetId, async () => {
            throwIfCancelled(context.signal);

            if (delivery === undefined) await sendMove({ via: "tab", point });
            else await delivery.prepareMove(sendMove);

            for (let count = 1; count <= clickCount; count += 1) {
                const press = async (from: PointerTarget): Promise<void> => {
                    await dispatcher(from).send({
                        targetId,
                        method: "Input.dispatchMouseEvent",
                        params: {
                            type      : "mousePressed",
                            x         : from.point.x,
                            y         : from.point.y,
                            modifiers,
                            button,
                            buttons,
                            clickCount: count,
                        },
                    });
                };
                const release = async (from: PointerTarget): Promise<void> => {
                    const event = {
                        type      : "mouseReleased",
                        x         : from.point.x,
                        y         : from.point.y,
                        modifiers,
                        button,
                        buttons,
                        clickCount: count,
                    };

                    try {
                        await dispatcher(from).send({
                            targetId,
                            method: "Input.dispatchMouseEvent",
                            params: event,
                        });
                    } catch (error) {
                        await dispatcher(from).send({
                            targetId,
                            method: "Input.dispatchMouseEvent",
                            params: event,
                        })
                            .catch(() => undefined);

                        throw error;
                    }
                };

                if (delivery === undefined) {
                    await press({ via: "tab", point });
                    await release({ via: "tab", point });
                } else {
                    await delivery.press(press, release);
                }
            }
        }));
}

export const inputClick = defineTool({
    name: "input_click",
    description:
        "Click at an element with trusted CDP mouse events, like a real user, without focusing the window.",
    access: "mutate",
    input : z.strictObject({
        tab       : tabSchema,
        target    : elementTargetSchema.describe("Element uid from a snapshot or query, or a CSS selector."),
        button    : z.enum(MOUSE_BUTTONS).optional().describe("Mouse button. Defaults to left."),
        clickCount: z.number().int().min(1).max(CLICK_COUNT_MAX).optional().describe("How many clicks in a row, 1 to 3. Defaults to 1."),
        modifiers : z.array(z.enum(KEY_MODIFIERS)).max(4).optional().describe("Held modifiers, for example Control for a control click."),
        position  : positionSchema.optional().describe("Offset in CSS pixels from the top left corner of the element. Defaults to the center."),
        force     : z.boolean().optional().describe("Skip the hit test and click through a covering element. Defaults to false."),
    }),
    output: z.strictObject({
        ok      : z.boolean().describe("Whether the mouse events were dispatched."),
        target  : targetSummarySchema.describe("The element that was clicked."),
        effect  : z.string().describe("Short summary of what happened."),
        urlAfter: z.string().optional().describe("URL after the click, present only when the click navigated."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        throwIfCancelled(context.signal);

        await ensureNoDialog(context.dialogs, targetId);
        await context.focus.ensure(context.access, targetId);

        return withElement(context, targetId, args.target, async (element) => {
            const { point, state, route } = await mousePoint(
                context,
                targetId,
                element,
                args.position,
                "click",
                args.force ?? false,
            );

            const button = args.button ?? "left";
            const clickCount = args.clickCount ?? 1;
            const acted = await dispatchClick(context, targetId, route, point, {
                button,
                clickCount,
                modifiers: [...new Set(args.modifiers ?? [])],
            });

            return {
                ok    : true,
                target: summarizeTarget(args.target.uid, state),
                effect: `The element was ${button} clicked${clickCount > 1 ? ` ${clickCount} times` : ""}.`,
                ...changedUrl(acted.urlBefore, acted.urlAfter),
            };
        });
    },
});

const HOVER_EXPRESSION = `function (element) { return element.matches(":hover"); }`;

const hoverSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.boolean().optional(),
    }),
});

export const inputHover = defineTool({
    name: "input_hover",
    description:
        "Hover an element with trusted CDP mouse events, so hover styles and menus react.",
    access: "mutate",
    input : z.strictObject({
        tab     : tabSchema,
        target  : elementTargetSchema.describe("Element uid from a snapshot or query, or a CSS selector."),
        position: positionSchema.optional().describe("Offset in CSS pixels from the top left corner of the element. Defaults to the center."),
        force   : z.boolean().optional().describe("Skip the hit test and hover through a covering element. Defaults to false."),
    }),
    output: z.strictObject({
        ok     : z.boolean().describe("Whether the element matches :hover now."),
        target : targetSummarySchema.describe("The element that was hovered."),
        effect : z.string().describe("Short summary of what happened."),
        hovered: z.boolean().describe("Whether element.matches(':hover') is true now."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        throwIfCancelled(context.signal);

        await ensureNoDialog(context.dialogs, targetId);
        await context.focus.ensure(context.access, targetId);

        return withElement(context, targetId, args.target, async (element) => {
            const { point, state, route } = await mousePoint(
                context,
                targetId,
                element,
                args.position,
                "hover",
                args.force ?? false,
            );

            const moveTo = async (via: PointerTarget["via"], x: number, y: number): Promise<void> => {
                const access = via === "frame" && route !== undefined ? route.owner : context.access;

                await access.send({
                    targetId,
                    method: "Input.dispatchMouseEvent",
                    params: {
                        type      : "mouseMoved",
                        x,
                        y,
                        modifiers : 0,
                        button    : "none",
                        buttons   : 0,
                        clickCount: 0,
                    },
                });
            };

            await withPointerDelivery(route, targetId, context, async (delivery) => {
                throwIfCancelled(context.signal);

                const moved = await delivery?.prepareMove((target) =>
                    moveTo(target.via, target.point.x, target.point.y));
                const via = moved?.via ?? "tab";
                const at = moved?.point ?? point;
                const leadIn = at.x >= 1 ? at.x - 1 : at.x + 1;

                for (let step = 0; step < HOVER_DEFAULT_STEPS; step += 1) {
                    await moveTo(via, step === HOVER_DEFAULT_STEPS - 1 ? at.x : leadIn, at.y);
                }
            });

            const parsed = hoverSchema.safeParse(
                await elementAccess(context.access, element).send({
                    targetId,
                    method: "Runtime.callFunctionOn",
                    params: {
                        functionDeclaration: HOVER_EXPRESSION,
                        objectId           : element.objectId,
                        arguments          : [{ objectId: element.objectId }],
                        returnByValue      : true,
                    },
                }),
            );

            if (!parsed.success) {
                throw new ToolError(
                    "The browser sent an unexpected response to Runtime.callFunctionOn. Try the call again.",
                );
            }

            const hovered = parsed.data.result.value ?? false;

            return {
                ok    : hovered,
                target: summarizeTarget(args.target.uid, state),
                effect: hovered
                    ? "The element is hovered."
                    : "The mouse moved to the element but :hover is not set. Another element may cover it.",
                hovered,
            };
        });
    },
});
