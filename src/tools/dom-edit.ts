import { z } from "zod";
import { elementState } from "./actionability.js";
import { defineTool } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import {
    elementAccess,
    elementTargetSchema,
    withElement,
} from "./element-target.js";
import { ToolError } from "./errors.js";
import { summarizeTarget, targetSummarySchema } from "./input-outcome.js";
import { throwIfCancelled } from "./registry.js";
import { truncateText } from "./result.js";
import { resolveTab, tabSchema } from "./tab-target.js";

export const DOM_EDIT_ACTIONS = [
    "set_attribute",
    "remove_attribute",
    "set_text",
    "set_html",
    "remove",
    "add_class",
    "remove_class",
    "toggle_class",
] as const;

export type DomEditAction = (typeof DOM_EDIT_ACTIONS)[number];

export const DOM_EDIT_NAME_MAX = 128;

export const DOM_EDIT_VALUE_MAX = 20000;

export const DOM_EDIT_HTML_MAX = 100000;

export const DOM_EDIT_CLASS_MAX = 128;

export const DOM_EDIT_PREVIOUS_MAX = 20000;

const ATTRIBUTE_NAME_PATTERN = /^[^\s"'<>\/=\x00-\x1F\x7F]+$/;

export function isValidAttributeName(name: string): boolean {
    return ATTRIBUTE_NAME_PATTERN.test(name);
}

export function isValidClassToken(token: string): boolean {
    return token !== "" && !/\s/.test(token);
}

export const DOM_EDIT_EXPRESSION = `function (element, request) {
  const action = request.action;
  if (action === "set_attribute") {
    const previous = element.getAttribute(request.name);
    element.setAttribute(request.name, request.value);
    return { previous };
  }
  if (action === "remove_attribute") {
    const previous = element.getAttribute(request.name);
    element.removeAttribute(request.name);
    return { previous };
  }
  if (action === "set_text") {
    const withMarkup = element.children.length > 0;
    const previous = withMarkup ? element.innerHTML : (element.textContent ?? "");
    element.textContent = request.text;
    return { previous, previousIsHtml: withMarkup };
  }
  if (action === "set_html") {
    const previous = element.innerHTML;
    element.innerHTML = request.html;
    return { previous };
  }
  if (action === "remove") {
    const previous = element.outerHTML;
    const parent = element.parentNode;
    const index = parent === null ? -1 : Array.prototype.indexOf.call(parent.childNodes, element);
    element.remove();
    return { previous, index };
  }
  if (action === "add_class") {
    const had = element.classList.contains(request.className);
    element.classList.add(request.className);
    return { had, has: element.classList.contains(request.className) };
  }
  if (action === "remove_class") {
    const had = element.classList.contains(request.className);
    element.classList.remove(request.className);
    return { had, has: element.classList.contains(request.className) };
  }
  if (action === "toggle_class") {
    const had = element.classList.contains(request.className);
    element.classList.toggle(request.className);
    return { had, has: element.classList.contains(request.className) };
  }
  throw new Error("Unknown dom_edit action.");
}`;

const domEditResultSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.object({
            previous      : z.string().nullable().optional(),
            had           : z.boolean().optional(),
            has           : z.boolean().optional(),
            previousIsHtml: z.boolean().optional(),
            index         : z.number().optional(),
        }).optional(),
    }),
    exceptionDetails: z.unknown().optional(),
});

type DomEditResult = {
    previousIsHtml?: boolean;
    index?         : number;
    previous?      : string | null;
    had?           : boolean;
    has?           : boolean;
};

export function buildDomEditRequest(args: {
    action    : DomEditAction;
    name?     : string | undefined;
    value?    : string | undefined;
    text?     : string | undefined;
    html?     : string | undefined;
    className?: string | undefined;
}): Record<string, unknown> {
    const request: Record<string, unknown> = { action: args.action };

    if (args.name !== undefined) request.name = args.name;
    if (args.value !== undefined) request.value = args.value;
    if (args.text !== undefined) request.text = args.text;
    if (args.html !== undefined) request.html = args.html;
    if (args.className !== undefined) request.className = args.className;

    return request;
}

export function shapePrevious(previous: string | null | undefined): {
    previous?   : string | null;
    truncated?  : boolean;
    totalLength?: number;
} {
    if (previous === undefined) return {};
    if (previous === null) return { previous: null };

    const shaped = truncateText(previous, DOM_EDIT_PREVIOUS_MAX);

    if (!shaped.truncated) return { previous };

    return { previous: shaped.text, truncated: true, totalLength: shaped.totalLength };
}

export function domEditEffect(
    action: DomEditAction,
    args  : { name?: string | undefined; className?: string | undefined },
    result: DomEditResult,
): string {
    switch (action) {
        case "set_attribute":
            return `The attribute ${JSON.stringify(args.name ?? "")} was set.`;

        case "remove_attribute":
            return result.previous === null || result.previous === undefined
                ? `The attribute ${JSON.stringify(args.name ?? "")} was already absent.`
                : `The attribute ${JSON.stringify(args.name ?? "")} was removed.`;

        case "set_text":
            return "The text of the element was replaced.";

        case "set_html":
            return "The HTML inside the element was replaced.";

        case "remove":
            return "The element was removed from the page.";

        case "add_class":
            return result.had === true
                ? `The element already had the class ${JSON.stringify(args.className ?? "")}.`
                : `The class ${JSON.stringify(args.className ?? "")} was added.`;

        case "remove_class":
            return result.had === true
                ? `The class ${JSON.stringify(args.className ?? "")} was removed.`
                : `The element did not have the class ${JSON.stringify(args.className ?? "")}.`;

        case "toggle_class":
            return result.has === true
                ? `The class ${JSON.stringify(args.className ?? "")} was toggled on.`
                : `The class ${JSON.stringify(args.className ?? "")} was toggled off.`;
    }
}

const SCRIPT_ATTRIBUTE = /^(?:on|srcdoc$)/i;

const SCRIPT_VALUE = /^(?:javascript|data|vbscript):/i;

// Browsers ignore control characters and spaces inside a scheme, so they are dropped before matching.
function withoutScriptNoise(value: string): string {
    return value.replace(/[\u0000-\u0020]/g, "");
}

export function isDangerousDomEdit(args: {
    action: DomEditAction;
    name? : string | undefined;
    value?: string | undefined;
}): boolean {
    if (args.action === "set_html" || args.action === "remove") return true;

    if (args.action !== "set_attribute") return false;

    return SCRIPT_ATTRIBUTE.test(args.name ?? "")
        || SCRIPT_VALUE.test(withoutScriptNoise(args.value ?? ""));
}

const FIELDS: Record<DomEditAction, readonly string[]> = {
    set_attribute   : ["name", "value"],
    remove_attribute: ["name"],
    set_text        : ["text"],
    set_html        : ["html"],
    remove          : [],
    add_class       : ["className"],
    remove_class    : ["className"],
    toggle_class    : ["className"],
};

const REQUIRED: Record<DomEditAction, readonly string[]> = {
    set_attribute   : ["name", "value"],
    remove_attribute: ["name"],
    set_text        : ["text"],
    set_html        : ["html"],
    remove          : [],
    add_class       : ["className"],
    remove_class    : ["className"],
    toggle_class    : ["className"],
};

const OPTION_FIELDS = [...new Set(Object.values(FIELDS).flat())];

export const domEdit = defineTool({
    name: "dom_edit",
    description:
        "Edit one element without JavaScript: attributes, text, HTML, removal or classes. Returns the previous value for a revert.",
    access   : "mutate",
    dangerous: (args) => isDangerousDomEdit(args),
    summarize: (args) => {
        if (args.action === "remove") return "It removes the element from the page.";

        if (args.action === "set_attribute") return "It sets an attribute that can run script in the page.";

        return "It replaces the HTML inside the element.";
    },
    input: z.strictObject({
        tab   : tabSchema,
        target: elementTargetSchema.describe("Element uid from a snapshot or query, or a CSS selector."),
        action: z.enum(DOM_EDIT_ACTIONS).describe("What to do."),
        name  : z.string().min(1).max(DOM_EDIT_NAME_MAX).refine(isValidAttributeName, {
            message: "Attribute names must not contain spaces, quotes, <, >, /, = or control characters.",
        }).optional().describe("Attribute name, for set_attribute and remove_attribute."),
        value    : z.string().max(DOM_EDIT_VALUE_MAX).optional().describe(`Attribute value, for set_attribute, up to ${DOM_EDIT_VALUE_MAX} characters.`),
        text     : z.string().max(DOM_EDIT_VALUE_MAX).optional().describe(`Text content, for set_text, up to ${DOM_EDIT_VALUE_MAX} characters.`),
        html     : z.string().max(DOM_EDIT_HTML_MAX).optional().describe(`HTML content, for set_html, up to ${DOM_EDIT_HTML_MAX} characters.`),
        className: z.string().min(1).max(DOM_EDIT_CLASS_MAX).refine(isValidClassToken, {
            message: "className must be a single class token without whitespace.",
        }).optional().describe("Class token, for add_class, remove_class and toggle_class."),
    }).superRefine((value, ctx) => {
        const record = value as Record<string, unknown>;
        const given = OPTION_FIELDS.filter((field) => record[field] !== undefined);

        for (const field of given) {
            if (!FIELDS[value.action].includes(field)) {
                ctx.addIssue({ code: "custom", message: `${field} does not apply to ${value.action}.` });
            }
        }

        for (const field of REQUIRED[value.action]) {
            if (!given.includes(field)) {
                ctx.addIssue({ code: "custom", message: `${value.action} needs ${field}.` });
            }
        }
    }),
    output: z.strictObject({
        ok            : z.boolean().describe("Whether the edit was applied."),
        action        : z.enum(DOM_EDIT_ACTIONS).describe("What ran."),
        target        : targetSummarySchema.describe("The element that was edited, before the edit."),
        effect        : z.string().describe("Short summary of what happened."),
        attribute     : z.string().optional().describe("Attribute name, for attribute actions."),
        className     : z.string().optional().describe("Class token, for class actions."),
        previous      : z.string().nullable().optional().describe(`Previous value for a revert: the attribute value or null when absent, the text, the HTML or the outer HTML. Truncated with a marker over ${DOM_EDIT_PREVIOUS_MAX} characters.`),
        previousIsHtml: z.boolean().optional().describe("For set_text: true when previous is the inner HTML because the element had child elements. Revert it with set_html."),
        index         : z.number().optional().describe("For remove: position of the element among the child nodes of its parent, or -1 when it had none."),
        had           : z.boolean().optional().describe("Whether the class was present before, for class actions."),
        has           : z.boolean().optional().describe("Whether the class is present now, for class actions."),
        truncated     : z.boolean().optional().describe("Whether previous was truncated."),
        totalLength   : z.number().optional().describe("Full length of previous in characters, when truncated."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        throwIfCancelled(context.signal);

        await ensureNoDialog(context.dialogs, targetId);

        return withElement(context, targetId, args.target, async (element) => {
            const owner = elementAccess(context.access, element);
            const checked = await elementState(owner, targetId, element);

            if (!checked.connected) {
                throw new ToolError(
                    "The element is no longer attached to the page. Take a new snapshot and try again.",
                );
            }

            const parsed = domEditResultSchema.safeParse(
                await owner.send({
                    targetId,
                    method: "Runtime.callFunctionOn",
                    params: {
                        functionDeclaration: DOM_EDIT_EXPRESSION,
                        objectId           : element.objectId,
                        arguments          : [
                            { objectId: element.objectId },
                            { value: buildDomEditRequest(args) },
                        ],
                        returnByValue: true,
                    },
                }),
            );

            if (!parsed.success) {
                throw new ToolError(
                    "The browser sent an unexpected response to Runtime.callFunctionOn. Try the call again.",
                );
            }

            const result = parsed.data.result.value;

            if (result === undefined || parsed.data.exceptionDetails !== undefined) {
                throw new ToolError(
                    "The browser could not apply the edit. Take a new snapshot and try again.",
                );
            }

            const shaped = shapePrevious(result.previous);
            const extra = {
                ...(result.previousIsHtml === undefined
                    ? {}
                    : { previousIsHtml: result.previousIsHtml }),
                ...(result.index === undefined ? {} : { index: result.index }),
            };
            const attribute = args.action === "set_attribute" || args.action === "remove_attribute"
                ? { attribute: args.name as string }
                : {};
            const classField = args.className === undefined ? {} : { className: args.className };
            const had = result.had === undefined ? {} : { had: result.had };
            const has = result.has === undefined ? {} : { has: result.has };

            return {
                ok    : true,
                action: args.action,
                target: summarizeTarget(args.target.uid, checked),
                effect: domEditEffect(args.action, args, result),
                ...attribute,
                ...classField,
                ...shaped,
                ...extra,
                ...had,
                ...has,
            };
        });
    },
});
