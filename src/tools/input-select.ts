import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { ensureActionable } from "./actionability.js";
import { defineTool } from "./define-tool.js";
import { elementTargetSchema, resolveElement, type ResolvedElement } from "./element-target.js";
import { ToolError } from "./errors.js";
import { changedUrl, navigationOf, summarizeTarget, targetSummarySchema } from "./input-click.js";
import { throwIfCancelled } from "./registry.js";

export const SELECT_OPTIONS_LIMIT = 50;

export interface SelectOption {
    value   : string;
    label   : string;
    selected: boolean;
}

export const SELECT_READ_EXPRESSION = `function (element) {
  if (!(element instanceof HTMLSelectElement)) return { select: false, options: [] };
  return {
    select: true,
    multiple: element.multiple,
    options: [...element.options].map((option) => ({
      value: option.value,
      label: option.label,
      selected: option.selected,
    })),
  };
}`;

const selectReadSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.object({
            select  : z.boolean(),
            multiple: z.boolean().optional(),
            options : z.array(z.object({
                value   : z.string(),
                label   : z.string(),
                selected: z.boolean(),
            })).optional(),
        }).optional(),
    }),
});

export const SELECT_WRITE_EXPRESSION = `function (element, wanted) {
  if (!(element instanceof HTMLSelectElement)) return { select: false, selected: [] };
  const indexes = new Set(wanted.map(Number));
  let at = 0;
  for (const option of element.options) {
    option.selected = indexes.has(at);
    at += 1;
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return {
    select: true,
    selected: [...element.selectedOptions].map((option) => ({
      value: option.value,
      label: option.label,
    })),
  };
}`;

const selectWriteSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.object({
            select  : z.boolean(),
            selected: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
        }).optional(),
    }),
});

export type SelectBy = { values: string[] } | { labels: string[] } | { indexes: number[] };

export function matchSelectOptions(
    options : SelectOption[],
    by      : SelectBy,
    multiple: boolean,
): { indexes: number[] } | { error: string } {
    const picked: number[] = [];

    if ("values" in by) {
        for (const value of by.values) {
            const at = options.findIndex((option) => option.value === value);

            if (at === -1) {
                return {
                    error: `No option has the value ${JSON.stringify(value)}. Available options: ${describeOptions(options)}.`,
                };
            }

            if (!picked.includes(at)) picked.push(at);
        }
    } else if ("labels" in by) {
        for (const label of by.labels) {
            const at = options.findIndex((option) => option.label === label);

            if (at === -1) {
                return {
                    error: `No option has the label ${JSON.stringify(label)}. Available options: ${describeOptions(options)}.`,
                };
            }

            if (!picked.includes(at)) picked.push(at);
        }
    } else {
        for (const index of by.indexes) {
            if (!Number.isInteger(index) || index < 0 || index >= options.length) {
                return {
                    error: `No option has the index ${index}. Available options: ${describeOptions(options)}.`,
                };
            }

            if (!picked.includes(index)) picked.push(index);
        }
    }

    if (!multiple && picked.length !== 1) {
        return {
            error: `A single select takes exactly one option, but ${picked.length} matched. Available options: ${describeOptions(options)}.`,
        };
    }

    return { indexes: picked };
}

export function describeOptions(options: SelectOption[]): string {
    const shown = options.slice(0, SELECT_OPTIONS_LIMIT).map((option, index) =>
        `${index}: value=${JSON.stringify(option.value)} label=${JSON.stringify(option.label)}`,
    );

    if (options.length > SELECT_OPTIONS_LIMIT) {
        shown.push(`... ${options.length - SELECT_OPTIONS_LIMIT} more`);
    }

    return shown.length === 0 ? "(no options)" : shown.join("; ");
}

async function readSelect(
    access : DaemonAccess,
    tab    : string,
    element: ResolvedElement,
): Promise<{ multiple: boolean; options: SelectOption[] }> {
    const parsed = selectReadSchema.safeParse(
        await access.send(tab, "Runtime.callFunctionOn", {
            functionDeclaration: SELECT_READ_EXPRESSION,
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

    const value = parsed.data.result.value;

    if (!value.select) {
        throw new ToolError("The element is not a select. Target a select element.");
    }

    return { multiple: value.multiple ?? false, options: value.options ?? [] };
}

export const inputSelect = defineTool({
    name: "input_select",
    description:
        "Choose options of a select element by value, label or index, firing input and change.",
    access: "mutate",
    input : z.strictObject({
        tab    : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        target : elementTargetSchema.describe("Element uid from a snapshot or query, or a CSS selector. Must resolve to a select."),
        values : z.array(z.string().max(500)).max(100).optional().describe("Option values to select, exactly one of values, labels or indexes."),
        labels : z.array(z.string().max(500)).max(100).optional().describe("Visible option labels to select, exactly one of values, labels or indexes."),
        indexes: z.array(z.number().int().min(0).max(10000)).max(100).optional().describe("Option indexes to select, exactly one of values, labels or indexes."),
    }).superRefine((value, ctx) => {
        const modes = [value.values, value.labels, value.indexes].filter(
            (entry) => entry !== undefined,
        ).length;

        if (modes !== 1) {
            ctx.addIssue({
                code   : "custom",
                message: "Provide exactly one of values, labels or indexes.",
            });
        }
    }),
    output: z.strictObject({
        ok      : z.boolean().describe("Whether the selection was applied."),
        target  : targetSummarySchema.describe("The select element."),
        effect  : z.string().describe("Short summary of what happened."),
        selected: z.array(z.strictObject({
            value: z.string().describe("Value of the selected option."),
            label: z.string().describe("Visible label of the selected option."),
        })).describe("Selected options after the call."),
        urlAfter: z.string().optional().describe("URL after the selection, present only when the page navigated."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        throwIfCancelled(context.signal);
        await context.focus.ensure(context.access, targetId);

        const element = await resolveElement(
            context.access,
            context.elements,
            targetId,
            args.target,
        );
        const checked = await ensureActionable(context.access, targetId, element, {
            checkDisabled: true,
        });

        if (!checked.state.selectable) {
            throw new ToolError(
                `The element <${checked.state.tag}> is not a select. Target a select element.`,
            );
        }

        const { multiple, options } = await readSelect(context.access, targetId, element);
        const by: SelectBy = args.values !== undefined
            ? { values: args.values }
            : args.labels !== undefined
                ? { labels: args.labels }
                : { indexes: args.indexes ?? [] };
        const matched = matchSelectOptions(options, by, multiple);

        if ("error" in matched) throw new ToolError(matched.error);

        const acted = await navigationOf(context.access, targetId, () =>
            context.access.send(targetId, "Runtime.callFunctionOn", {
                functionDeclaration: SELECT_WRITE_EXPRESSION,
                objectId           : element.objectId,
                arguments          : [{ objectId: element.objectId }, { value: matched.indexes }],
                returnByValue      : true,
            }));

        const parsed = selectWriteSchema.safeParse(acted.value);

        if (!parsed.success || parsed.data.result.value === undefined) {
            throw new ToolError(
                "The browser sent an unexpected response to Runtime.callFunctionOn. Try the call again.",
            );
        }

        const selected = parsed.data.result.value.selected ?? [];

        return {
            ok    : true,
            target: summarizeTarget(args.target.uid, checked.state),
            effect: selected.length === 1
                ? `The option ${JSON.stringify(selected[0]?.label ?? "")} was selected.`
                : `${selected.length} options were selected.`,
            selected,
            ...changedUrl(acted.urlBefore, acted.urlAfter),
        };
    },
});
