import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { ensureActionable } from "./actionability.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { elementTargetSchema, resolveElement, type ResolvedElement } from "./element-target.js";
import { ToolError } from "./errors.js";
import { changedUrl, navigationOf, summarizeTarget, targetSummarySchema } from "./input-click.js";
import {
    type KeyEventPlan,
    planKeyPress,
    planTypedChar,
    parseKeyChord,
} from "./keys.js";
import { throwIfCancelled } from "./registry.js";

export const TYPE_MAX_CHARS = 20000;

export const TYPE_DELAY_MAX_MS = 200;

export const TYPE_ECHO_CHARS = 50;

export const KEY_REPEAT_MAX = 20;

export const PLATFORM_EXPRESSION = "navigator.platform ?? ''";

const platformSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.string().optional(),
    }),
});

export const VALUE_EXPRESSION = `function (element) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return { length: element.value.length, text: element.value };
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    return { length: (element.innerText ?? "").length, text: element.innerText ?? "" };
  }
  return { length: 0, text: "" };
}`;

const valueSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.object({ length: z.number(), text: z.string() }).optional(),
    }),
});

const editableCache = new Map<string, string>();

export function platformCacheKey(tab: string, generation: number): string {
    return `${generation}:${tab}`;
}

export async function browserPlatform(
    access            : DaemonAccess,
    elementsGeneration: { generation(tab: string): number },
    tab               : string,
): Promise<string> {
    const key = platformCacheKey(tab, elementsGeneration.generation(tab));
    const cached = editableCache.get(key);

    if (cached !== undefined) return cached;

    const parsed = platformSchema.safeParse(
        await access.send(tab, "Runtime.evaluate", {
            expression   : PLATFORM_EXPRESSION,
            returnByValue: true,
        }),
    );

    if (!parsed.success) {
        throw new ToolError(
            "The browser sent an unexpected response to Runtime.evaluate. Try the call again.",
        );
    }

    const platform = parsed.data.result.value ?? "";

    editableCache.set(key, platform);

    return platform;
}

export function clearPlatformCache(): void {
    editableCache.clear();
}

async function dispatchKeyEvents(
    access: DaemonAccess,
    tab   : string,
    events: KeyEventPlan[],
    signal: AbortSignal,
): Promise<void> {
    for (const event of events) {
        throwIfCancelled(signal);

        const { type, ...rest } = event;

        await access.send(tab, "Input.dispatchKeyEvent", { type, ...rest });
    }
}

async function readValue(
    access : DaemonAccess,
    tab    : string,
    element: ResolvedElement,
): Promise<{ length: number; text: string }> {
    const parsed = valueSchema.safeParse(
        await access.send(tab, "Runtime.callFunctionOn", {
            functionDeclaration: VALUE_EXPRESSION,
            objectId           : element.objectId,
            arguments          : [{ objectId: element.objectId }],
            returnByValue      : true,
        }),
    );

    if (!parsed.success || parsed.data.result.value === undefined) {
        throw new ToolError(
            "The browser sent an unexpected response to Runtime.callFunctionOn. Try the call again.",
        );
    }

    return parsed.data.result.value;
}

async function focusElement(
    access : DaemonAccess,
    tab    : string,
    element: ResolvedElement,
): Promise<void> {
    const backendNodeId = element.backendNodeId;

    await access.send(tab, "DOM.focus", { backendNodeId });
}

export function echoOf(text: string, password: boolean): string | undefined {
    if (password) return undefined;

    return text.length <= TYPE_ECHO_CHARS ? text : text.slice(0, TYPE_ECHO_CHARS);
}

export const inputType = defineTool({
    name: "input_type",
    description:
        "Type text into a field with trusted input events, focusing it first without clicking.",
    access: "mutate",
    input : z.strictObject({
        tab    : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        text   : z.string().min(1).max(TYPE_MAX_CHARS).describe("Text to type, up to 20000 characters."),
        target : elementTargetSchema.optional().describe("Element uid from a snapshot or query, or a CSS selector. Omit to type into the focused element."),
        clear  : z.boolean().optional().describe("Select all and delete in the field first. Defaults to false."),
        submit : z.boolean().optional().describe("Press Enter after typing. Defaults to false."),
        delayMs: z.number().int().min(0).max(TYPE_DELAY_MAX_MS).optional().describe("Delay between characters in ms, 0 to 200. With 0 the text is inserted at once. Defaults to 0."),
    }),
    output: z.strictObject({
        ok         : z.boolean().describe("Whether the field now contains the text."),
        target     : targetSummarySchema.optional().describe("The element that was typed into, when a target was given."),
        effect     : z.string().describe("Short summary of what happened."),
        valueLength: z.number().describe("Length of the field value after typing."),
        typed      : z.string().optional().describe("First 50 characters of the typed text, never present for password fields."),
        contains   : z.boolean().describe("Whether the field value contains the typed text."),
        urlAfter   : z.string().optional().describe("URL after typing, present only when the page navigated, for example after submit."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        throwIfCancelled(context.signal);

        await ensureNoDialog(context.dialogs, targetId);
        await context.focus.ensure(context.access, targetId);

        let element: ResolvedElement | undefined;
        let password = false;
        let summary: ReturnType<typeof summarizeTarget> | undefined;

        if (args.target !== undefined) {
            const resolved = await resolveElement(
                context.access,
                context.elements,
                targetId,
                args.target,
            );
            const checked = await ensureActionable(context.access, targetId, resolved, {
                checkDisabled: true,
            });

            if (checked.state.fileInput) {
                throw new ToolError(
                    "The element is a file input and cannot be typed into. Use input_upload instead.",
                );
            }

            if (checked.state.editable === "none") {
                throw new ToolError(
                    `The element <${checked.state.tag}> cannot be typed into. Target an input that accepts text, a textarea or an editable element.`,
                );
            }

            password = checked.state.editable === "password";
            element = resolved;
            summary = summarizeTarget(args.target.uid, checked.state);
        }

        const delayMs = args.delayMs ?? 0;

        const acted = await navigationOf(context.access, targetId, async () => {
            if (element !== undefined) await focusElement(context.access, targetId, element);

            if (args.clear === true) await clearField(context, targetId);

            if (delayMs === 0) {
                throwIfCancelled(context.signal);
                await context.access.send(targetId, "Input.insertText", { text: args.text });
            } else {
                await typeSlowly(context, targetId, args.text, delayMs);
            }

            if (args.submit === true) await pressEnter(context, targetId);
        });

        const echo = echoOf(args.text, password);

        if (element === undefined) {
            return {
                ok         : true,
                effect     : "The text was typed into the focused element.",
                valueLength: 0,
                ...(echo === undefined ? {} : { typed: echo }),
                contains   : true,
                ...changedUrl(acted.urlBefore, acted.urlAfter),
            };
        }

        const outcome = await readValue(context.access, targetId, element);
        const contains = outcome.text.includes(args.text);

        return {
            ok    : contains,
            target: summary,
            effect: contains
                ? "The text was typed into the element."
                : "The text was typed but the field does not contain it. The page may have filtered the input.",
            valueLength: outcome.length,
            ...(echo === undefined ? {} : { typed: echo }),
            contains,
            ...changedUrl(acted.urlBefore, acted.urlAfter),
        };
    },
});

async function clearField(context: ToolContext, targetId: string): Promise<void> {
    const platform = await browserPlatform(context.access, context.elements, targetId);

    await dispatchKeyEvents(
        context.access,
        targetId,
        planKeyPress(parseKeyChord("ControlOrMeta+A"), platform, 1),
        context.signal,
    );
    await dispatchKeyEvents(
        context.access,
        targetId,
        planKeyPress(parseKeyChord("Backspace"), "", 1),
        context.signal,
    );
}

async function typeSlowly(
    context : ToolContext,
    targetId: string,
    text    : string,
    delayMs : number,
): Promise<void> {
    for (const char of text) {
        throwIfCancelled(context.signal);
        const planned = planTypedChar(char);

        if (planned === undefined) {
            await context.access.send(targetId, "Input.insertText", { text: char });
        } else {
            await dispatchKeyEvents(context.access, targetId, planned, context.signal);
        }

        await context.clock.sleep(delayMs);
        throwIfCancelled(context.signal);
    }
}

async function pressEnter(context: ToolContext, targetId: string): Promise<void> {
    await dispatchKeyEvents(
        context.access,
        targetId,
        planKeyPress(parseKeyChord("Enter"), "", 1),
        context.signal,
    );
}

export const inputKey = defineTool({
    name: "input_key",
    description:
        "Press a key or chord like Enter or ControlOrMeta+C with trusted CDP key events.",
    access: "mutate",
    input : z.strictObject({
        tab   : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        key   : z.string().min(1).max(64).describe("Key or chord, for example Enter, Tab, Control+A, ControlOrMeta+C, Shift++ (a trailing plus names the plus key)."),
        target: elementTargetSchema.optional().describe("Element uid from a snapshot or query, or a CSS selector. The element is focused first; omit to press into the focused element."),
        repeat: z.number().int().min(1).max(KEY_REPEAT_MAX).optional().describe("How many times to press, 1 to 20. Modifiers are held across repeats. Defaults to 1."),
    }),
    output: z.strictObject({
        ok      : z.boolean().describe("Whether the key events were dispatched."),
        target  : targetSummarySchema.optional().describe("The element that was focused first, when a target was given."),
        effect  : z.string().describe("Short summary of what happened."),
        pressed : z.string().describe("The key chord that was pressed."),
        urlAfter: z.string().optional().describe("URL after the press, present only when the press navigated."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        const parsed = parseKeyChord(args.key);
        const repeat = args.repeat ?? 1;

        throwIfCancelled(context.signal);

        await ensureNoDialog(context.dialogs, targetId);
        await context.focus.ensure(context.access, targetId);
        const platform = parsed.controlOrMeta
            ? await browserPlatform(context.access, context.elements, targetId)
            : "";

        let summary: ReturnType<typeof summarizeTarget> | undefined;

        if (args.target !== undefined) {
            const resolved = await resolveElement(
                context.access,
                context.elements,
                targetId,
                args.target,
            );
            const checked = await ensureActionable(context.access, targetId, resolved, {
                checkDisabled: true,
            });

            summary = summarizeTarget(args.target.uid, checked.state);
            await focusElement(context.access, targetId, resolved);
        }

        const events = planKeyPress(parsed, platform, repeat);

        throwIfCancelled(context.signal);
        const acted = await navigationOf(context.access, targetId, () =>
            dispatchKeyEvents(context.access, targetId, events, context.signal));

        return {
            ok     : true,
            ...(summary === undefined ? {} : { target: summary }),
            effect : `The key ${args.key} was pressed${repeat > 1 ? ` ${repeat} times` : ""}.`,
            pressed: args.key,
            ...changedUrl(acted.urlBefore, acted.urlAfter),
        };
    },
});
