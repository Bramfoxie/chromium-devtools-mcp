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

export const CSS_EDIT_ACTIONS = ["set_style", "add_rule", "remove_rule"] as const;

export type CssEditAction = (typeof CSS_EDIT_ACTIONS)[number];

export const CSS_EDIT_DECLARATIONS_MAX = 50;

export const CSS_EDIT_NAME_MAX = 128;

export const CSS_EDIT_VALUE_MAX = 4000;

export const CSS_EDIT_SELECTOR_MAX = 1024;

export const CSS_EDIT_RULE_VALUE_MAX = 20000;

export const CSS_EDIT_PREVIOUS_MAX = 20000;

export const CDM_STYLE_MARKER = "data-cdm";

const CUSTOM_PROPERTY_PATTERN = /^--[A-Za-z0-9_-]+$/;

const PROPERTY_PATTERN = /^[a-zA-Z-]+$/;

const IMPORTANT_SUFFIX = /\s*!important\s*$/i;

export function isValidPropertyName(name: string): boolean {
    if (name.length > CSS_EDIT_NAME_MAX) return false;

    return CUSTOM_PROPERTY_PATTERN.test(name) || PROPERTY_PATTERN.test(name);
}

export function splitImportant(value: string): { value: string; important: boolean } {
    const match = IMPORTANT_SUFFIX.exec(value);

    if (match === null) return { value: value.trim(), important: false };

    return { value: value.slice(0, match.index).trim(), important: true };
}

const SET_STYLE_EXPRESSION = `function (element, request) {
  const declarations = request.declarations;
  const previous = {};
  const computed = {};
  const view = element.ownerDocument.defaultView;
  for (const entry of declarations) {
    previous[entry.name] = element.style.getPropertyValue(entry.name);
    if (entry.important) element.style.setProperty(entry.name, entry.value, "important");
    else element.style.setProperty(entry.name, entry.value);
    computed[entry.name] = view === null ? "" : view.getComputedStyle(element).getPropertyValue(entry.name);
  }
  return { previous, computed };
}`;

const ADD_RULE_EXPRESSION = `function (element, request) {
  const doc = element.ownerDocument;
  let style = doc.querySelector("style[data-cdm]");
  if (style === null) {
    style = doc.createElement("style");
    style.setAttribute("data-cdm", "");
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  const sheet = style.sheet;
  const marked = request.rule.replace("{", "{ --cdm-id: \\"" + request.ruleId + "\\";");
  const index = sheet.cssRules.length;
  try {
    sheet.insertRule(marked, index);
  } catch (error) {
    if (sheet.cssRules.length === 0) style.remove();
    throw error;
  }
  const rule = sheet.cssRules[index];
  return { ruleId: request.ruleId, selector: rule.selectorText };
}`;

const REMOVE_RULE_EXPRESSION = `function (element, request) {
  const doc = element.ownerDocument;
  const style = doc.querySelector("style[data-cdm]");
  if (style === null) return { removed: false, selector: "" };
  const sheet = style.sheet;
  let found = -1;
  for (let index = 0; index < sheet.cssRules.length; index += 1) {
    const rule = sheet.cssRules[index];
    const marked = rule.style ? rule.style.getPropertyValue("--cdm-id").replace(/["']/g, "") : "";
    if (marked === request.ruleId) { found = index; break; }
  }
  if (found === -1) return { removed: false, selector: "" };
  const rule = sheet.cssRules[found];
  const selector = rule.selectorText;
  sheet.deleteRule(found);
  if (sheet.cssRules.length === 0) style.remove();
  return { removed: true, selector };
}`;

interface CssEditRequest {
    declarations?: Array<{ name: string; value: string; important: boolean }>;
    rule?        : string;
    ruleId?      : string;
}

export function buildSetStyleRequest(declarations: Record<string, string>): CssEditRequest {
    return {
        declarations: Object.entries(declarations).map(([name, raw]) => {
            const split = splitImportant(raw);

            return { name, value: split.value, important: split.important };
        }),
    };
}

export function buildRuleText(selector: string, declarations: Record<string, string>): string {
    const body = Object.entries(declarations)
        .map(([name, value]) => `${name}: ${value};`)
        .join(" ");

    return `${selector} { ${body} }`;
}

const setStyleResultSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.object({
            previous: z.record(z.string(), z.string()),
            computed: z.record(z.string(), z.string()),
        }).optional(),
    }),
    exceptionDetails: z.unknown().optional(),
});

const addRuleResultSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.object({
            ruleId  : z.string(),
            selector: z.string(),
            preview : z.string().optional(),
        }).optional(),
    }),
    exceptionDetails: z.unknown().optional(),
});

const removeRuleResultSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.object({
            removed : z.boolean(),
            selector: z.string(),
        }).optional(),
    }),
    exceptionDetails: z.unknown().optional(),
});

export function clipPreviousMap(previous: Record<string, string>): {
    previous   : Record<string, string>;
    truncated  : boolean;
    totalLength: number | undefined;
} {
    const shaped: Record<string, string> = {};
    let truncated = false;
    let totalLength = 0;

    for (const [name, value] of Object.entries(previous)) {
        const entry = truncateText(value, CSS_EDIT_PREVIOUS_MAX);

        shaped[name] = entry.text;
        if (entry.truncated) truncated = true;

        totalLength += entry.totalLength;
    }

    return { previous: shaped, truncated, totalLength: truncated ? totalLength : undefined };
}

const declarationValue = z.string().max(CSS_EDIT_VALUE_MAX);

const declarationsSchema = z.record(
    z.string().min(1).max(CSS_EDIT_NAME_MAX),
    declarationValue,
).refine(
    (declarations) => Object.keys(declarations).every(isValidPropertyName),
    { message: "Property names must be CSS properties like color or custom properties like --brand." },
).refine(
    (declarations) => {
        const count = Object.keys(declarations).length;

        return count >= 1 && count <= CSS_EDIT_DECLARATIONS_MAX;
    },
    { message: `Provide 1 to ${CSS_EDIT_DECLARATIONS_MAX} declarations.` },
);

const FIELDS: Record<CssEditAction, readonly string[]> = {
    set_style  : ["declarations"],
    add_rule   : ["selector", "declarations"],
    remove_rule: ["ruleId"],
};

const REQUIRED: Record<CssEditAction, readonly string[]> = {
    set_style  : ["declarations"],
    add_rule   : ["selector", "declarations"],
    remove_rule: ["ruleId"],
};

const OPTION_FIELDS = [...new Set(Object.values(FIELDS).flat())];

export const cssEdit = defineTool({
    name: "css_edit",
    description:
        "Edit page styles without JavaScript: inline styles of one element, or rules in a page style tag. Returns the previous values for a revert.",
    access: "mutate",
    input : z.strictObject({
        tab         : tabSchema,
        target      : elementTargetSchema.describe("Element uid from a snapshot or query, or a CSS selector. For add_rule and remove_rule it selects the document to hold the rule."),
        action      : z.enum(CSS_EDIT_ACTIONS).describe("What to do."),
        declarations: declarationsSchema.optional().describe("Property to value map, for set_style and add_rule. An empty value removes an inline property."),
        selector    : z.string().min(1).max(CSS_EDIT_SELECTOR_MAX).optional().describe("Rule selector, for add_rule."),
        ruleId      : z.string().min(1).max(64).optional().describe("Rule id from add_rule, for remove_rule."),
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
        ok          : z.boolean().describe("Whether the edit was applied."),
        action      : z.enum(CSS_EDIT_ACTIONS).describe("What ran."),
        target      : targetSummarySchema.describe("The element that was edited, or the one that selected the document."),
        effect      : z.string().describe("Short summary of what happened."),
        previous    : z.record(z.string(), z.string()).optional().describe(`Previous inline values by property, for set_style. Each value is truncated with a marker over ${CSS_EDIT_PREVIOUS_MAX} characters.`),
        computed    : z.record(z.string(), z.string()).optional().describe("Computed values of the touched properties after the edit, for set_style."),
        declarations: z.record(z.string(), z.string()).optional().describe("Declarations of the rule, for add_rule."),
        selector    : z.string().optional().describe("Selector of the rule as the browser parsed it, for add_rule and remove_rule."),
        ruleId      : z.string().optional().describe("Rule id, for add_rule. Pass it to remove_rule."),
        removed     : z.boolean().optional().describe("Whether a rule was removed, for remove_rule."),
        truncated   : z.boolean().optional().describe("Whether previous was truncated."),
        totalLength : z.number().optional().describe("Total characters of the previous values, when truncated."),
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

            const summary = summarizeTarget(args.target.uid, checked);

            if (args.action === "set_style") {
                const declarations = args.declarations as Record<string, string>;

                return setStyle(owner, targetId, element.objectId, declarations, summary);
            }

            if (args.action === "add_rule") {
                return addRule(
                    owner,
                    targetId,
                    element.objectId,
                    args.selector as string,
                    args.declarations as Record<string, string>,
                    summary,
                );
            }

            return removeRule(owner, targetId, element.objectId, args.ruleId as string, summary);
        });
    },
});

async function setStyle(
    owner       : import("../mcp/index.js").DaemonAccess,
    targetId    : string,
    objectId    : string,
    declarations: Record<string, string>,
    summary     : ReturnType<typeof summarizeTarget>,
) {
    const parsed = setStyleResultSchema.safeParse(
        await owner.send({
            targetId,
            method: "Runtime.callFunctionOn",
            params: {
                functionDeclaration: SET_STYLE_EXPRESSION,
                objectId,
                arguments          : [
                    { objectId },
                    { value: buildSetStyleRequest(declarations) },
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

    if (parsed.data.result.value === undefined || parsed.data.exceptionDetails !== undefined) {
        throw new ToolError(
            "The browser could not apply the style. Take a new snapshot and try again.",
        );
    }

    const clipped = clipPreviousMap(parsed.data.result.value.previous);

    return {
        ok      : true as const,
        action  : "set_style" as const,
        target  : summary,
        effect  : "The inline style of the element was edited.",
        previous: clipped.previous,
        computed: parsed.data.result.value.computed,
        ...(clipped.truncated
            ? { truncated: true as const, totalLength: clipped.totalLength as number }
            : {}),
    };
}

let cssRuleCounter = 0;

function nextRuleId(): string {
    cssRuleCounter += 1;

    return `cdm-${Date.now().toString(36)}-${cssRuleCounter.toString(36)}`;
}

async function addRule(
    owner       : import("../mcp/index.js").DaemonAccess,
    targetId    : string,
    objectId    : string,
    selector    : string,
    declarations: Record<string, string>,
    summary     : ReturnType<typeof summarizeTarget>,
) {
    const rule = buildRuleText(selector, declarations);

    if (rule.length > CSS_EDIT_RULE_VALUE_MAX) {
        throw new ToolError(
            `The rule is over the ${CSS_EDIT_RULE_VALUE_MAX} character limit. Use fewer or shorter declarations.`,
        );
    }

    const ruleId = nextRuleId();
    const parsed = addRuleResultSchema.safeParse(
        await owner.send({
            targetId,
            method: "Runtime.callFunctionOn",
            params: {
                functionDeclaration: ADD_RULE_EXPRESSION,
                objectId,
                arguments          : [{ objectId }, { value: { rule, ruleId } }],
                returnByValue      : true,
            },
        }),
    );

    if (!parsed.success) {
        throw new ToolError(
            "The browser sent an unexpected response to Runtime.callFunctionOn. Try the call again.",
        );
    }

    if (parsed.data.exceptionDetails !== undefined) {
        throw new ToolError(
            `The selector ${JSON.stringify(selector)} is invalid. Check the selector and try again.`,
        );
    }

    if (parsed.data.result.value === undefined) {
        throw new ToolError(
            "The browser sent an unexpected response to Runtime.callFunctionOn. Try the call again.",
        );
    }

    return {
        ok          : true as const,
        action      : "add_rule" as const,
        target      : summary,
        effect      : "The rule was added.",
        declarations: { ...declarations },
        selector    : parsed.data.result.value.selector,
        ruleId      : parsed.data.result.value.ruleId,
    };
}

async function removeRule(
    owner   : import("../mcp/index.js").DaemonAccess,
    targetId: string,
    objectId: string,
    ruleId  : string,
    summary : ReturnType<typeof summarizeTarget>,
) {
    const parsed = removeRuleResultSchema.safeParse(
        await owner.send({
            targetId,
            method: "Runtime.callFunctionOn",
            params: {
                functionDeclaration: REMOVE_RULE_EXPRESSION,
                objectId,
                arguments          : [{ objectId }, { value: { ruleId } }],
                returnByValue      : true,
            },
        }),
    );

    if (!parsed.success) {
        throw new ToolError(
            "The browser sent an unexpected response to Runtime.callFunctionOn. Try the call again.",
        );
    }

    if (parsed.data.result.value === undefined || parsed.data.exceptionDetails !== undefined) {
        throw new ToolError(
            "The browser could not remove the rule. Take a new snapshot and try again.",
        );
    }

    const removed = parsed.data.result.value.removed;

    return {
        ok    : removed,
        action: "remove_rule" as const,
        target: summary,
        effect: removed
            ? "The rule was removed."
            : "No rule with that id exists. It may already have been removed.",
        removed: removed,
        ...(removed ? { selector: parsed.data.result.value.selector, ruleId } : {}),
    };
}
