import { z } from "zod";
import { redactUrl, sensitiveName } from "./capture/redact.js";
import { defineTool } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { ToolError } from "./errors.js";
import {
    EXTRACT_KINDS,
    EXTRACT_TEXT_CHARS,
    extractExpression,
    type ExtractKind,
} from "./page-extract-script.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const EXTRACT_TIMEOUT_MS = 8000;

const DEFAULT_LIMIT = 50;

const MAX_LIMIT = 200;

function text(): z.ZodType<string> {
    return z.string().transform((value) => value.slice(0, EXTRACT_TEXT_CHARS));
}

function url(): z.ZodType<string> {
    return z.string().transform((value) => redactUrl(value).slice(0, 2000));
}

function group<T extends z.ZodType>(item: T) {
    return z.object({
        total: z.number().int().nonnegative(),
        items: z.array(item),
    });
}

const field = z.object({
    tag     : text(),
    type    : text(),
    name    : text(),
    label   : text(),
    required: z.boolean(),
});

const pageSchema = z.object({
    url      : url(),
    title    : text(),
    lang     : text(),
    canonical: url(),
    links    : group(z.object({ text: text(), href: url(), rel: text() })).optional(),
    headings : group(z.object({ level: z.number().int().min(1).max(6), text: text() })).optional(),
    meta     : group(z.object({ name: text(), content: text() })).optional(),
    forms    : group(z.object({
        id        : text(),
        name      : text(),
        method    : text(),
        action    : url(),
        fieldTotal: z.number().int().nonnegative(),
        fields    : z.array(field),
    })).optional(),
});

const HIDDEN = "[hidden]";

const evaluatedSchema = z.object({
    result          : z.object({ value: z.unknown().optional() }),
    exceptionDetails: z.unknown().optional(),
});

function counted<T>(value: { total: number; items: T[] } | undefined, limit: number) {
    if (value === undefined) return undefined;

    const items = value.items.slice(0, limit);

    return { total: value.total, truncated: value.total > items.length, items };
}

const countedOutput = <T extends z.ZodType>(item: T) => z.strictObject({
    total    : z.number().describe("How many were found on the page."),
    truncated: z.boolean().describe("Whether more were found than are listed."),
    items    : z.array(item),
}).optional();

export const pageExtract = defineTool({
    name: "page_extract",
    description:
        "Read the links, headings, meta tags and form structure of the top document of a tab as lists, without form values.",
    access: "read",
    input : z.strictObject({
        tab  : tabSchema,
        kinds: z.array(z.enum(EXTRACT_KINDS)).min(1).max(EXTRACT_KINDS.length).optional()
            .describe("What to read: links, headings, meta, forms. Defaults to all four."),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional()
            .describe(`Most items per kind. Defaults to ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}.`),
    }),
    output: z.strictObject({
        tab      : z.string().describe("Tab id."),
        url      : z.string().describe("URL of the document, with secrets in it hidden."),
        title    : z.string().describe("Title of the document."),
        lang     : z.string().describe("Language of the document, empty when not set."),
        canonical: z.string().describe("Canonical URL of the document, empty when not set."),
        links    : countedOutput(z.strictObject({
            text: z.string().describe("Visible text of the link."),
            href: z.string().describe("Absolute target, with secrets in it hidden."),
            rel : z.string().describe("The rel attribute, empty when not set."),
        })).describe("Links with an href."),
        headings: countedOutput(z.strictObject({
            level: z.number().describe("Heading level from 1 to 6."),
            text : z.string().describe("Text of the heading."),
        })).describe("Headings in document order."),
        meta: countedOutput(z.strictObject({
            name   : z.string().describe("The name, property or http-equiv of the tag."),
            content: z.string().describe("The content of the tag."),
        })).describe("Meta tags."),
        forms: countedOutput(z.strictObject({
            id        : z.string().describe("The id of the form, empty when not set."),
            name      : z.string().describe("The name of the form, empty when not set."),
            method    : z.string().describe("Submit method, lower case."),
            action    : z.string().describe("Absolute submit target, with secrets in it hidden."),
            fieldTotal: z.number().describe("How many controls the form has."),
            fields    : z.array(z.strictObject({
                tag     : z.string(),
                type    : z.string().describe("The type attribute, empty when not set."),
                name    : z.string().describe("The name attribute, empty when not set."),
                label   : z.string().describe("Label, aria-label or placeholder, empty when none."),
                required: z.boolean(),
            })).describe("Controls of the form. Values are never read."),
        })).describe("Forms and their controls."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);
        const kinds: readonly ExtractKind[] = args.kinds ?? EXTRACT_KINDS;
        const limit = args.limit ?? DEFAULT_LIMIT;

        await ensureNoDialog(context.dialogs, targetId);

        const raw = await context.access.send({
            targetId,
            method   : "Runtime.evaluate",
            params   : { expression: extractExpression(kinds, limit), returnByValue: true },
            timeoutMs: EXTRACT_TIMEOUT_MS,
        });
        const evaluated = evaluatedSchema.safeParse(raw);

        if (!evaluated.success || evaluated.data.exceptionDetails !== undefined) {
            throw new ToolError(
                "The page did not return its structure. Check that the tab shows a normal page and try again.",
            );
        }

        const page = pageSchema.safeParse(evaluated.data.result.value);

        if (!page.success) {
            throw new ToolError(
                "The page returned data in an unexpected form. Check that the tab shows a normal page and try again.",
            );
        }

        const data = page.data;

        return {
            tab      : targetId,
            url      : data.url,
            title    : data.title,
            lang     : data.lang,
            canonical: data.canonical,
            links    : counted(data.links, limit),
            headings : counted(data.headings, limit),
            meta     : counted(
                data.meta === undefined
                    ? undefined
                    : {
                        total: data.meta.total,
                        items: data.meta.items.map((tag) => ({
                            name   : tag.name,
                            content: sensitiveName(tag.name) ? HIDDEN : tag.content,
                        })),
                    },
                limit,
            ),
            forms: counted(data.forms, limit),
        };
    },
});
