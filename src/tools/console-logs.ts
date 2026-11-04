import { z } from "zod";
import { defineTool } from "./define-tool.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const CONSOLE_LOGS_DEFAULT_LIMIT = 100;

const CONSOLE_LOGS_MAX_LIMIT = 500;

const levelSchema = z.enum(["debug", "info", "warning", "error"]);

const consoleEntrySchema = z.strictObject({
    id    : z.number().describe("Monotonic entry id for afterId paging."),
    time  : z.string().describe("ISO time when the MCP server received the message."),
    level : levelSchema.describe("Severity of the message."),
    source: z.enum(["console", "exception", "browser"]).describe("console for console.* calls, exception for uncaught errors, browser for browser generated messages."),
    text  : z.string().describe("Message text, clipped to 2000 characters."),
    url   : z.string().optional().describe("Script URL, when known."),
    line  : z.number().optional().describe("Line number, when known."),
    column: z.number().optional().describe("Column number, when known."),
    stack : z.string().optional().describe("Stack trace clipped to 20 frames, when known."),
});

export const consoleLogs = defineTool({
    name: "console_logs",
    description:
        "Read console messages, uncaught exceptions and browser messages of a tab. Only messages since capture started, plus what the browser replays.",
    access: "read",
    input : z.strictObject({
        tab         : tabSchema,
        levels      : z.array(levelSchema).max(4).optional().describe("Keep only these severities."),
        textContains: z.string().min(1).max(1024).optional().describe("Keep only messages containing this text."),
        afterId     : z.number().int().min(0).optional().describe("Return entries after this id for paging."),
        limit       : z.number().int().min(1).max(CONSOLE_LOGS_MAX_LIMIT).optional().describe("Maximum entries to return. Defaults to 100."),
        clear       : z.boolean().optional().describe("Empty the buffer after reading. Defaults to false."),
        order       : z.enum(["oldest", "newest"]).optional().describe("Entry order. Defaults to oldest."),
    }),
    output: z.strictObject({
        tab          : z.string().describe("Tab id."),
        entries      : z.array(consoleEntrySchema).describe("Buffered console entries."),
        nextAfterId  : z.number().describe("Pass as afterId to continue paging."),
        droppedCount : z.number().describe("Entries evicted from the buffer since the last read."),
        returned     : z.number().describe("Number of returned entries."),
        totalBuffered: z.number().describe("Entries currently buffered for the tab."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        await context.capture.ensureConsole(targetId);

        const read = context.capture.readConsole(targetId, {
            levels      : args.levels,
            textContains: args.textContains,
            afterId     : args.afterId,
            limit       : args.limit ?? CONSOLE_LOGS_DEFAULT_LIMIT,
            order       : args.order ?? "oldest",
            clear       : args.clear ?? false,
        });

        return {
            tab          : targetId,
            entries      : read.entries.map(({ id, entry }) => ({ id, ...entry })),
            nextAfterId  : read.nextAfterId,
            droppedCount : read.droppedCount,
            returned     : read.entries.length,
            totalBuffered: read.totalBuffered,
        };
    },
});
