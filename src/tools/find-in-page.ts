import { z } from "zod";
import { defineTool } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { ToolError } from "./errors.js";
import { FIND_MAX_MATCHES, findExpression } from "./find-in-page-script.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const FIND_TIMEOUT_MS = 8000;

const DEFAULT_MATCHES = 10;

const CONTEXT_CHARS = 200;

const rectSchema = z.strictObject({
    x     : z.number(),
    y     : z.number(),
    width : z.number(),
    height: z.number(),
});

const pageSchema = z.object({
    total    : z.number().int().nonnegative(),
    exhausted: z.boolean(),
    scrolled : z.boolean(),
    matches  : z.array(z.object({
        context   : z.string().transform((value) => value.slice(0, CONTEXT_CHARS)),
        tag       : z.string().transform((value) => value.slice(0, 40)),
        rect      : rectSchema,
        inViewport: z.boolean(),
    })),
});

const evaluatedSchema = z.object({
    result          : z.object({ value: z.unknown().optional() }),
    exceptionDetails: z.unknown().optional(),
});

export const findInPage = defineTool({
    name: "find_in_page",
    description:
        "Find visible text in the top document of a tab, list where it is, and with scroll true bring one match to the middle of the view.",
    access: (args: unknown) => ((args as { scroll?: unknown } | null)?.scroll === true ? "mutate" : "read"),
    input : z.strictObject({
        tab          : tabSchema,
        text         : z.string().min(1).max(200).describe("Text to find. A match lies inside one text node."),
        caseSensitive: z.boolean().optional().describe("Match the case exactly. Defaults to false."),
        maxMatches   : z.number().int().min(1).max(FIND_MAX_MATCHES).optional()
            .describe(`Most matches to list. Defaults to ${DEFAULT_MATCHES}, at most ${FIND_MAX_MATCHES}.`),
        scroll: z.boolean().optional().describe("Scroll a match into view. Defaults to false, which changes nothing."),
        index : z.number().int().min(0).max(FIND_MAX_MATCHES - 1).optional()
            .describe("Which listed match to scroll to when scroll is true. Defaults to 0."),
    }),
    output: z.strictObject({
        tab       : z.string().describe("Tab id."),
        text      : z.string().describe("The text that was searched for."),
        total     : z.number().describe("How many visible matches were found."),
        truncated : z.boolean().describe("Whether more matches exist than are listed."),
        incomplete: z.boolean().describe("Whether the page was too large to search completely."),
        scrolled  : z.boolean().describe("Whether a match was scrolled into view."),
        matches   : z.array(z.strictObject({
            index     : z.number().describe("Position in this list, usable as index."),
            context   : z.string().describe("The match with the text around it."),
            tag       : z.string().describe("Tag of the element that holds the text."),
            rect      : rectSchema.describe("Position in the viewport in CSS pixels, after any scroll."),
            inViewport: z.boolean().describe("Whether the match is at least partly in the viewport."),
        })),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);
        const maxMatches = args.maxMatches ?? DEFAULT_MATCHES;

        await ensureNoDialog(context.dialogs, targetId);

        const raw = await context.access.send({
            targetId,
            method: "Runtime.evaluate",
            params: {
                expression: findExpression({
                    query        : args.text,
                    caseSensitive: args.caseSensitive ?? false,
                    maxMatches,
                    scrollIndex  : args.scroll === true ? (args.index ?? 0) : -1,
                }),
                returnByValue: true,
            },
            timeoutMs: FIND_TIMEOUT_MS,
        });
        const evaluated = evaluatedSchema.safeParse(raw);

        if (!evaluated.success || evaluated.data.exceptionDetails !== undefined) {
            throw new ToolError(
                "The page did not answer the search. Check that the tab shows a normal page and try again.",
            );
        }

        const page = pageSchema.safeParse(evaluated.data.result.value);

        if (!page.success) {
            throw new ToolError(
                "The page returned data in an unexpected form. Check that the tab shows a normal page and try again.",
            );
        }

        const matches = page.data.matches.slice(0, maxMatches);

        return {
            tab       : targetId,
            text      : args.text,
            total     : page.data.total,
            truncated : page.data.total > matches.length,
            incomplete: page.data.exhausted,
            scrolled  : page.data.scrolled,
            matches   : matches.map((match, index) => ({ index, ...match })),
        };
    },
});
