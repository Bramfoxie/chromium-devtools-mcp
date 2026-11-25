import { z } from "zod";
import { defineTool } from "./define-tool.js";
import { historySchema } from "./page-navigate-state.js";
import { redactUrl } from "./capture/redact.js";
import { ToolError } from "./errors.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const MAX_ENTRIES = 100;
const MAX_TEXT = 2048;

export const pageHistory = defineTool({
    name       : "page_history",
    description: "List the recent navigation history of a tab with redacted addresses.",
    access     : "read",
    input      : z.strictObject({
        tab  : tabSchema,
        limit: z.number().int().min(1).max(MAX_ENTRIES).optional().describe("Maximum number of entries. Defaults to 50."),
    }),
    output: z.strictObject({
        tab         : z.string(),
        currentIndex: z.number().int(),
        total       : z.number().int(),
        truncated   : z.boolean(),
        entries     : z.array(z.strictObject({
            index: z.number().int(), url: z.string(), title: z.string(),
        })),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);
        const history = historySchema.safeParse(await context.access.send({
            targetId,
            method: "Page.getNavigationHistory",
            params: {},
        }));

        if (!history.success || !Number.isInteger(history.data.currentIndex)
            || history.data.currentIndex < 0
            || history.data.currentIndex >= history.data.entries.length) {
            throw new ToolError("The browser sent an unexpected navigation history. Try the call again.");
        }

        const { entries, currentIndex } = history.data;
        const limit = args.limit ?? 50;
        const start = Math.max(0, Math.min(
            currentIndex - Math.floor(limit / 2), entries.length - limit,
        ));
        const selected = entries.slice(start, start + limit);

        return {
            tab      : targetId,
            currentIndex,
            total    : entries.length,
            truncated: selected.length < entries.length || selected.some(
                (entry) => entry.url.length > MAX_TEXT || entry.title.length > MAX_TEXT,
            ),
            entries: selected.map((entry, offset) => ({
                index: start + offset,
                url  : redactUrl(entry.url).slice(0, MAX_TEXT),
                title: entry.title.slice(0, MAX_TEXT),
            })),
        };
    },
});
