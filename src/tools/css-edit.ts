import { z } from "zod";
import { elementState } from "./actionability.js";
import { isFetchingCssValue } from "./css-value.js";
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
  const style = element.style;
  const previous = Object.create(null);
  const computed = Object.create(null);
  const before = [];
  const rejected = [];
  for (const entry of request.declarations) {
    const prior = style.getPropertyValue(entry.name);
    const priority = style.getPropertyPriority(entry.name);
    before.push([entry.name, prior, priority]);
    previous[entry.name] = prior !== "" && priority === "important" ? prior + " !important" : prior;
    if (entry.value === "") {
      style.removeProperty(entry.name);
    } else {
      style.setProperty(entry.name, entry.value, entry.important ? "important" : "");
      if (style.getPropertyValue(entry.name) === "") rejected.push(entry.name);
    }
  }
  if (rejected.length > 0) {
    for (const [name, prior, priority] of before.reverse()) {
      if (prior === "") style.removeProperty(name);
      else style.setProperty(name, prior, priority);
    }
    return { rejected };
  }
  const view = element.ownerDocument.defaultView;
  for (const entry of request.declarations) {
    computed[entry.name] = view === null ? "" : view.getComputedStyle(element).getPropertyValue(entry.name);
  }
  return { previous, computed };
}`;

const RULE_HOLDER = `
  const root = element.getRootNode();
  const holder = typeof ShadowRoot === "function" && root instanceof ShadowRoot ? root : element.ownerDocument;
  const styleKey = Symbol.for("chromium-devtools-mcp.style");
  const rulesKey = Symbol.for("chromium-devtools-mcp.rules");`;

const ADD_RULE_EXPRESSION = `function (element, request) {${RULE_HOLDER}
  let style = holder[styleKey];
  if (!style || !style.isConnected) {
    style = element.ownerDocument.createElement("style");
    style.setAttribute("data-cdm", "");
    const parent = holder === element.ownerDocument ? (holder.head ?? holder.documentElement) : holder;
    parent.appendChild(style);
    style[rulesKey] = [];
    holder[styleKey] = style;
  }
  const drop = () => {
    if (style.sheet !== null && style.sheet.cssRules.length > 0) return;
    style.remove();
    delete holder[styleKey];
  };
  const sheet = style.sheet;
  if (sheet === null) { drop(); return { error: "sheet" }; }
  const index = sheet.cssRules.length;
  try {
    sheet.insertRule(request.selector + " {}", index);
  } catch (error) {
    drop();
    return { error: "selector" };
  }
  const rule = sheet.cssRules[index];
  if (sheet.cssRules.length !== index + 1 || rule.type !== 1 || rule.style.length !== 0) {
    while (sheet.cssRules.length > index) sheet.deleteRule(sheet.cssRules.length - 1);
    drop();
    return { error: "selector" };
  }
  const applied = Object.create(null);
  const rejected = [];
  for (const entry of request.declarations) {
    rule.style.setProperty(entry.name, entry.value, entry.important ? "important" : "");
    const value = rule.style.getPropertyValue(entry.name);
    if (value === "") rejected.push(entry.name);
    else applied[entry.name] = rule.style.getPropertyPriority(entry.name) === "important" ? value + " !important" : value;
  }
  if (rejected.length > 0) {
    sheet.deleteRule(index);
    drop();
    return { error: "declaration", rejected };
  }
  style[rulesKey].push({ id: request.ruleId, rule, selector: rule.selectorText });
  return { ruleId: request.ruleId, selector: rule.selectorText, applied };
}`;

const REMOVE_RULE_EXPRESSION = `function (element, request) {${RULE_HOLDER}
  const style = holder[styleKey];
  if (!style || !style.isConnected) return { removed: false, selector: "" };
  const entries = style[rulesKey];
  const at = entries.findIndex((entry) => entry.id === request.ruleId);
  if (at === -1) return { removed: false, selector: "" };
  const entry = entries[at];
  entries.splice(at, 1);
  const sheet = style.sheet;
  const index = sheet === null ? -1 : Array.prototype.indexOf.call(sheet.cssRules, entry.rule);
  if (index !== -1) sheet.deleteRule(index);
  if (entries.length === 0) {
    style.remove();
    delete holder[styleKey];
  }
  return { removed: true, selector: entry.selector };
}`;

interface CssDeclaration {
    name     : string;
    value    : string;
    important: boolean;
}

function propertyKey(name: string): string {
    return name.startsWith("--") ? name : name.toLowerCase();
}

export function toDeclarations(declarations: Record<string, string>): CssDeclaration[] {
    return Object.entries(declarations).map(([name, raw]) => {
        const split = splitImportant(raw);

        return { name: propertyKey(name), value: split.value, important: split.important };
    });
}

export function buildSetStyleRequest(declarations: Record<string, string>): {
    declarations: CssDeclaration[];
} {
    return { declarations: toDeclarations(declarations) };
}

export function buildRuleRequest(
    selector    : string,
    declarations: Record<string, string>,
    ruleId      : string,
): { selector: string; declarations: CssDeclaration[]; ruleId: string } {
    return { selector, declarations: toDeclarations(declarations), ruleId };
}

export function isDangerousCssEdit(args: {
    declarations?: Record<string, string> | undefined;
}): boolean {
    return Object.values(args.declarations ?? {}).some(isFetchingCssValue);
}

const setStyleResultSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.object({
            previous: z.record(z.string(), z.string()).optional(),
            computed: z.record(z.string(), z.string()).optional(),
            rejected: z.array(z.string()).optional(),
        }).optional(),
    }),
    exceptionDetails: z.unknown().optional(),
});

const addRuleResultSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.object({
            ruleId  : z.string().optional(),
            selector: z.string().optional(),
            applied : z.record(z.string(), z.string()).optional(),
            error   : z.enum(["sheet", "selector", "declaration"]).optional(),
            rejected: z.array(z.string()).optional(),
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
).refine(
    (declarations) => {
        const names = Object.keys(declarations);

        return new Set(names.map(propertyKey)).size === names.length;
    },
    { message: "Each property may appear once, property names are not case sensitive." },
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
    access   : "mutate",
    dangerous: (args) => isDangerousCssEdit(args),
    summarize: () => "It sets a style that makes the page load an address.",
    input    : z.strictObject({
        tab         : tabSchema,
        target      : elementTargetSchema.describe("Element uid from a snapshot or query, or a CSS selector. For add_rule and remove_rule it selects the document, or the shadow root, that holds the rule."),
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

    const value = parsed.data.result.value;

    if (value === undefined || parsed.data.exceptionDetails !== undefined) {
        throw new ToolError(
            "The browser could not apply the style. Take a new snapshot and try again.",
        );
    }

    if (value.rejected !== undefined) {
        throw new ToolError(
            `The browser did not accept ${value.rejected.join(", ")}. Nothing was changed. Check the property names and values.`,
        );
    }

    const clipped = clipPreviousMap(value.previous ?? {});

    return {
        ok      : true as const,
        action  : "set_style" as const,
        target  : summary,
        effect  : "The inline style of the element was edited.",
        previous: clipped.previous,
        computed: value.computed ?? {},
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
    const size = Object.entries(declarations).reduce(
        (sum, [name, value]) => sum + name.length + value.length,
        0,
    );

    if (size > CSS_EDIT_RULE_VALUE_MAX) {
        throw new ToolError(
            `The declarations are over the ${CSS_EDIT_RULE_VALUE_MAX} character limit. Use fewer or shorter declarations.`,
        );
    }

    if (Object.values(declarations).some((value) => splitImportant(value).value === "")) {
        throw new ToolError("A rule needs a value for every property. Use set_style to remove an inline property.");
    }

    const ruleId = nextRuleId();
    const parsed = addRuleResultSchema.safeParse(
        await owner.send({
            targetId,
            method: "Runtime.callFunctionOn",
            params: {
                functionDeclaration: ADD_RULE_EXPRESSION,
                objectId,
                arguments          : [
                    { objectId },
                    { value: buildRuleRequest(selector, declarations, ruleId) },
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

    const value = parsed.data.result.value;

    if (value === undefined || parsed.data.exceptionDetails !== undefined) {
        throw new ToolError(
            "The browser could not add the rule. Take a new snapshot and try again.",
        );
    }

    if (value.error === "selector") {
        throw new ToolError(
            `The selector ${JSON.stringify(selector)} is not a style rule selector. Check it and try again. Nothing was added.`,
        );
    }

    if (value.error === "declaration") {
        throw new ToolError(
            `The browser did not accept ${(value.rejected ?? []).join(", ")}. Nothing was added. Check the property names and values.`,
        );
    }

    if (value.error === "sheet" || value.ruleId === undefined || value.applied === undefined) {
        throw new ToolError(
            "The page does not accept a style tag here, a Content-Security-Policy may block it. Nothing was added.",
        );
    }

    return {
        ok          : true as const,
        action      : "add_rule" as const,
        target      : summary,
        effect      : "The rule was added.",
        declarations: value.applied,
        selector    : value.selector ?? selector,
        ruleId      : value.ruleId,
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
