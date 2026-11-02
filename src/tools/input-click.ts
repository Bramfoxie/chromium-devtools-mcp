import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import {
    coveredMessage,
    type ElementState,
    ensureActionable,
    hitTest,
} from "./actionability.js";
import { clickPointOf, type ClickPoint, TOP_LEVEL_ORIGIN } from "./coordinates.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { type Measurement, withPointerDelivery, type PointerRoute } from "./pointer-delivery.js";
import { frameChain, mapPoint, measureChain, outerHitTest, revealChain } from "./frame-geometry.js";
import {
    elementTargetSchema,
    type Rect,
    elementAccess,
    revealElement,
    withElement,
    type ResolvedElement,
} from "./element-target.js";
import { ToolError } from "./errors.js";
import { KEY_MODIFIERS, modifiersMask } from "./keys.js";
import { throwIfCancelled } from "./registry.js";

export const CLICK_EXPRESSION = `function (element, scroll) {
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

export type MouseButton = (typeof MOUSE_BUTTONS)[number];

export const MOUSE_BUTTON_BIT: Record<MouseButton, number> = {
    left  : 1,
    middle: 4,
    right : 2,
};

export const CLICK_COUNT_MAX = 3;

export const HOVER_DEFAULT_STEPS = 2;

export const positionSchema = z.strictObject({
    x: z.number().describe("Offset in CSS pixels from the left edge of the element."),
    y: z.number().describe("Offset in CSS pixels from the top edge of the element."),
});

export const targetSummarySchema = z.strictObject({
    uid    : z.string().optional().describe("Element id, when the call used one."),
    tag    : z.string().describe("Tag of the element."),
    id     : z.string().optional().describe("Id of the element, when it has one."),
    classes: z.array(z.string()).describe("Class names of the element, at most 10."),
});

export type TargetSummary = z.infer<typeof targetSummarySchema>;

export function summarizeTarget(uid: string | undefined, state: ElementState): TargetSummary {
    return {
        ...(uid === undefined ? {} : { uid }),
        tag    : state.tag,
        ...(state.id === "" ? {} : { id: state.id }),
        classes: state.classes,
    };
}

async function currentUrl(access: DaemonAccess, targetId: string): Promise<string> {
    try {
        const result = (await access.send(targetId, "Runtime.evaluate", {
            expression   : "location.href",
            returnByValue: true,
        })) as { result?: { value?: unknown } } | null;

        return typeof result?.result?.value === "string" ? result.result.value : "";
    } catch {
        return "";
    }
}

export async function navigationOf<T>(
    access  : DaemonAccess,
    targetId: string,
    run     : () => Promise<T>,
): Promise<{ value: T; urlBefore: string; urlAfter: string }> {
    const urlBefore = await currentUrl(access, targetId);
    const value = await run();
    const urlAfter = await currentUrl(access, targetId);

    return { value, urlBefore, urlAfter };
}

export function changedUrl(urlBefore: string, urlAfter: string): { urlAfter?: string } {
    return urlBefore === "" || urlBefore === urlAfter ? {} : { urlAfter };
}

async function mousePoint(
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

    if (hit.kind === "covered") throw new ToolError(coveredMessage(hit.by, verb));

    if (hit.kind === "outside") {
        throw new ToolError(
            "The target point lies outside the page viewport. Scroll the page and try again.",
        );
    }

    return { point: local, state: scrolled.state, box: scrolled.box };
}

async function isolatedPoint(
    context : ToolContext,
    targetId: string,
    frameId : string,
    box     : Rect,
    local   : ClickPoint,
    request : {
        owner   : DaemonAccess;
        element : ResolvedElement;
        verb    : string;
        force   : boolean;
        position: { x: number; y: number } | undefined;
    },
): Promise<{ point: ClickPoint; route?: PointerRoute }> {
    const chain = await frameChain(context.access, context.frames, targetId, frameId);

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

        return {
            point: mapPoint(
                fresh.toTop,
                clickPointOf(revealed.box, request.position, TOP_LEVEL_ORIGIN),
            ),
            boxes: fresh.boxes,
        };
    };
    const route: PointerRoute | undefined = chain.links.length === 0 ? undefined : {
        owner    : request.owner,
        objectId : request.element.objectId,
        relays   : [context.access, ...chain.links.map((link) => link.access), request.owner],
        links    : chain.links,
        initial  : { point, boxes: measured.boxes },
        measure,
        stillOver: request.force
            ? undefined
            : async () => (await hitTest(request.owner, targetId, request.element, local, true)).kind === "hit",
    };

    if (request.force) return { point, route };

    const inner = await hitTest(request.owner, targetId, request.element, local, true);

    if (inner.kind === "covered") throw new ToolError(coveredMessage(inner.by, request.verb));

    if (inner.kind === "outside") {
        throw new ToolError(
            "The target point lies outside the frame viewport. Scroll the frame and try again.",
        );
    }

    const outer = await outerHitTest(chain, measured, targetId, local);

    if (outer.kind === "covered") throw new ToolError(coveredMessage(outer.by, request.verb));

    if (outer.kind === "outside") {
        throw new ToolError(
            "The target point lies outside the page viewport. Scroll the page and try again.",
        );
    }

    return { point, route };
}

export const click = defineTool({
    name: "click",
    description:
        "Click an element at the DOM level with element.click() semantics, without moving the mouse.",
    access: "mutate",
    input : z.strictObject({
        tab           : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
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
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

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
                owner.send(targetId, "Runtime.callFunctionOn", {
                    functionDeclaration: CLICK_EXPRESSION,
                    objectId           : element.objectId,
                    arguments          : [{ objectId: element.objectId }, { value: scroll }],
                    returnByValue      : true,
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

export const inputClick = defineTool({
    name: "input_click",
    description:
        "Click at an element with trusted CDP mouse events, like a real user, without focusing the window.",
    access: "mutate",
    input : z.strictObject({
        tab       : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
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
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

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
            const held = [...new Set(args.modifiers ?? [])];
            const modifiers = modifiersMask(held);
            const buttons = MOUSE_BUTTON_BIT[button];

            throwIfCancelled(context.signal);

            const sendMove = async (at: { x: number; y: number }): Promise<void> => {
                await context.access.send(targetId, "Input.dispatchMouseEvent", {
                    type      : "mouseMoved",
                    x         : at.x,
                    y         : at.y,
                    modifiers,
                    button,
                    buttons   : 0,
                    clickCount: 0,
                });
            };

            const acted = await withPointerDelivery(route, targetId, (delivery) =>
                navigationOf(context.access, targetId, async () => {
                    if (delivery === undefined) await sendMove(point);
                    else await delivery.prepareMove(sendMove);

                    for (let count = 1; count <= clickCount; count += 1) {
                        const press = async (from: { x: number; y: number }): Promise<void> => {
                            await context.access.send(targetId, "Input.dispatchMouseEvent", {
                                type      : "mousePressed",
                                x         : from.x,
                                y         : from.y,
                                modifiers,
                                button,
                                buttons,
                                clickCount: count,
                            });
                        };
                        const release = async (from: { x: number; y: number }): Promise<void> => {
                            const event = {
                                type      : "mouseReleased",
                                x         : from.x,
                                y         : from.y,
                                modifiers,
                                button,
                                buttons,
                                clickCount: count,
                            };

                            try {
                                await context.access.send(targetId, "Input.dispatchMouseEvent", event);
                            } catch (error) {
                                await context.access.send(targetId, "Input.dispatchMouseEvent", event)
                                    .catch(() => undefined);

                                throw error;
                            }
                        };

                        if (delivery === undefined) {
                            await press(point);
                            await release(point);
                        } else {
                            await delivery.press(press, release);
                        }
                    }
                }));

            return {
                ok    : true,
                target: summarizeTarget(args.target.uid, state),
                effect: `The element was ${button} clicked${clickCount > 1 ? ` ${clickCount} times` : ""}.`,
                ...changedUrl(acted.urlBefore, acted.urlAfter),
            };
        });
    },
});

export const HOVER_EXPRESSION = `function (element) { return element.matches(":hover"); }`;

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
        tab     : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
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
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

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

            throwIfCancelled(context.signal);

            const moveTo = async (x: number, y: number): Promise<void> => {
                await context.access.send(targetId, "Input.dispatchMouseEvent", {
                    type      : "mouseMoved",
                    x,
                    y,
                    modifiers : 0,
                    button    : "none",
                    buttons   : 0,
                    clickCount: 0,
                });
            };

            await withPointerDelivery(route, targetId, async (delivery) => {
                const moved = await delivery?.prepareMove((target) => moveTo(target.x, target.y));
                const at = moved ?? point;
                const leadIn = at.x >= 1 ? at.x - 1 : at.x + 1;

                for (let step = 0; step < HOVER_DEFAULT_STEPS; step += 1) {
                    await moveTo(step === HOVER_DEFAULT_STEPS - 1 ? at.x : leadIn, at.y);
                }
            });

            const parsed = hoverSchema.safeParse(
                await elementAccess(context.access, element).send(targetId, "Runtime.callFunctionOn", {
                    functionDeclaration: HOVER_EXPRESSION,
                    objectId           : element.objectId,
                    arguments          : [{ objectId: element.objectId }],
                    returnByValue      : true,
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
