import { z } from "zod";
import { ensureActionable } from "./actionability.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import {
    elementAccess,
    type ElementTarget,
    elementTargetSchema,
    withElement,
} from "./element-target.js";
import { ToolError } from "./errors.js";
import { click } from "./input-click.js";
import { describeOptions, inputSelect, type SelectOption } from "./input-select.js";
import { clearText, inputType } from "./input-text.js";
import { throwIfCancelled } from "./registry.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const FIELDS_MAX = 30;

const VALUE_MAX_CHARS = 20000;

const OPTIONS_MAX = 100;

const KIND_EXPRESSION = `function (element) {
  if (element instanceof HTMLSelectElement) {
    return {
      kind: "select",
      options: [...element.options].map((option) => ({ value: option.value, label: option.label })),
    };
  }
  if (element instanceof HTMLTextAreaElement) return { kind: "text" };
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (type === "checkbox" || type === "radio") return { kind: type, checked: element.checked };
    if (type === "file") return { kind: "file" };
    const inert = ["button", "submit", "reset", "image", "range", "color", "hidden"];
    return { kind: inert.includes(type) ? "other" : "text" };
  }
  if (element instanceof HTMLElement && element.isContentEditable) return { kind: "text" };
  return { kind: "other" };
}`;

const FIELD_KINDS = ["text", "select", "checkbox", "radio", "file", "other"] as const;

type FieldKind = (typeof FIELD_KINDS)[number];

const kindSchema = z.object({
    result: z.object({
        value: z.object({
            kind   : z.enum(FIELD_KINDS),
            checked: z.boolean().optional(),
            options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
        }).optional(),
    }),
});

const fieldSchema = z.strictObject({
    target: elementTargetSchema.describe("The field: element uid from a snapshot or query, or a CSS selector."),
    value : z
        .union([
            z.string().max(VALUE_MAX_CHARS),
            z.boolean(),
            z.array(z.string().max(500)).max(OPTIONS_MAX),
        ])
        .describe("Text for a text field (an empty string clears it), true or false for a checkbox, true for a radio button, an option value or label (a list for a multiple select) for a select."),
});

type Field = z.infer<typeof fieldSchema>;

const resultSchema = z.strictObject({
    index : z.number().describe("Position of the field in the list, starting at 1."),
    kind  : z.enum(["text", "select", "checkbox", "radio"]).describe("What kind of field it was."),
    effect: z.string().describe("Short summary of what happened to the field."),
});

type FieldResult = z.infer<typeof resultSchema>;

interface Probe {
    kind    : FieldKind;
    checked?: boolean | undefined;
    options?: Array<{ value: string; label: string }> | undefined;
}

function describeTarget(target: ElementTarget): string {
    if (target.uid !== undefined) return `uid ${target.uid}`;

    if (target.locator !== undefined) return `locator ${JSON.stringify(target.locator)}`;

    return `selector ${JSON.stringify(target.selector)}`;
}

function wrongValue(kind: string, expected: string): ToolError {
    return new ToolError(`A ${kind} field takes ${expected}.`);
}

async function kindOf(
    context : ToolContext,
    targetId: string,
    target  : ElementTarget,
): Promise<Probe> {
    return withElement(context, targetId, target, async (element) => {
        const owner = elementAccess(context.access, element);

        await ensureActionable(owner, targetId, element, { checkDisabled: true });

        const parsed = kindSchema.safeParse(
            await owner.send({
                targetId,
                method: "Runtime.callFunctionOn",
                params: {
                    functionDeclaration: KIND_EXPRESSION,
                    objectId           : element.objectId,
                    arguments          : [{ objectId: element.objectId }],
                    returnByValue      : true,
                },
            }),
        );

        if (!parsed.success || parsed.data.result.value === undefined) {
            throw new ToolError(
                "The browser sent an unexpected response to Runtime.callFunctionOn. Try the call again.",
            );
        }

        return parsed.data.result.value;
    });
}

async function fillText(
    context : ToolContext,
    targetId: string,
    field   : Field,
): Promise<string> {
    if (typeof field.value !== "string") throw wrongValue("text", "a string");

    if (field.value === "") {
        await withElement(context, targetId, field.target, (element) =>
            clearText(context, targetId, element));

        return "The field was cleared.";
    }

    const typed = await inputType.handler(
        { tab: targetId, target: field.target, text: field.value, clear: true },
        context,
    );

    if (!typed.ok) throw new ToolError(typed.effect);

    return typed.effect;
}

function optionIndexes(options: SelectOption[], wanted: string[]): number[] {
    return wanted.map((entry) => {
        const byValue = options.findIndex((option) => option.value === entry);
        const at = byValue === -1 ? options.findIndex((option) => option.label === entry) : byValue;

        if (at === -1) {
            throw new ToolError(
                `No option has the value or label ${JSON.stringify(entry)}. Available options: ${describeOptions(options)}.`,
            );
        }

        return at;
    });
}

async function fillSelect(
    context : ToolContext,
    targetId: string,
    field   : Field,
    probe   : Probe,
): Promise<string> {
    const wanted = typeof field.value === "string"
        ? [field.value]
        : Array.isArray(field.value) ? field.value : undefined;

    if (wanted === undefined) throw wrongValue("select", "an option value or label, or a list of them");

    const options = (probe.options ?? []).map((option) => ({ ...option, selected: false }));
    const indexes = [...new Set(optionIndexes(options, wanted))];
    const selected = await inputSelect.handler(
        { tab: targetId, target: field.target, indexes },
        context,
    );

    if (!selected.ok) throw new ToolError(selected.effect);

    return selected.effect;
}

async function fillCheckable(
    context : ToolContext,
    targetId: string,
    field   : Field,
    probe   : Probe,
): Promise<string> {
    if (typeof field.value !== "boolean") {
        throw wrongValue(probe.kind, "true or false");
    }

    if (probe.kind === "radio" && !field.value) {
        throw new ToolError(
            "A radio button cannot be unchecked. Check another radio button of the group instead.",
        );
    }

    if (probe.checked === field.value) {
        return field.value ? "The box was already checked." : "The box was already unchecked.";
    }

    await click.handler({ tab: targetId, target: field.target, scrollIntoView: true }, context);

    const after = await kindOf(context, targetId, field.target);

    if (after.checked !== field.value) {
        throw new ToolError("The click did not change the state. The page may have reverted it.");
    }

    return field.value ? "The box was checked." : "The box was unchecked.";
}

async function fillField(
    context : ToolContext,
    targetId: string,
    field   : Field,
): Promise<{ kind: FieldResult["kind"]; effect: string }> {
    const probe = await kindOf(context, targetId, field.target);

    switch (probe.kind) {
        case "text":
            return { kind: "text", effect: await fillText(context, targetId, field) };

        case "select":
            return { kind: "select", effect: await fillSelect(context, targetId, field, probe) };

        case "checkbox":
        case "radio":
            return {
                kind  : probe.kind,
                effect: await fillCheckable(context, targetId, field, probe),
            };

        case "file":
            throw new ToolError("The element is a file input. Use input_upload instead.");

        case "other":
            throw new ToolError("The element is not a field that takes a value.");
    }
}

function range(from: number, to: number): string {
    return from === to ? `field ${from}` : `fields ${from} to ${to}`;
}

function failure(index: number, total: number, field: Field, error: unknown): ToolError {
    const reason = error instanceof Error ? error.message : String(error);
    const filled = index === 0 ? "No field was filled" : `${capitalized(range(1, index))} ${index === 1 ? "was" : "were"} filled`;
    const left = total - index - 1;
    const rest = left === 0
        ? ""
        : `, ${range(index + 2, total)} ${left === 1 ? "was" : "were"} not attempted`;

    return new ToolError(
        `Field ${index + 1} of ${total} (${describeTarget(field.target)}) failed: ${reason} ${filled}${rest}.`,
    );
}

function capitalized(text: string): string {
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export const fillForm = defineTool({
    name: "fill_form",
    description:
        "Fill several form fields in one call, in order: text and textarea fields, selects, checkboxes and radio buttons. Stops at the first field that fails and says which fields were filled.",
    access: "mutate",
    input : z.strictObject({
        tab   : tabSchema,
        fields: z.array(fieldSchema).min(1).max(FIELDS_MAX).describe(`Fields to fill, 1 to ${FIELDS_MAX}.`),
    }),
    output: z.strictObject({
        ok    : z.boolean().describe("Whether every field was filled."),
        filled: z.number().describe("How many fields were filled."),
        fields: z.array(resultSchema).describe("One entry per filled field."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        await ensureNoDialog(context.dialogs, targetId);
        await context.focus.ensure(context.access, targetId);

        const results: FieldResult[] = [];

        for (const [index, field] of args.fields.entries()) {
            throwIfCancelled(context.signal);

            try {
                const done = await fillField(context, targetId, field);

                results.push({ index: index + 1, ...done });
            } catch (error) {
                if (context.signal.aborted) throw error;

                throw failure(index, args.fields.length, field, error);
            }
        }

        return { ok: true, filled: results.length, fields: results };
    },
});
