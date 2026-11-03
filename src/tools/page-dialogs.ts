import { z } from "zod";
import { defineTool } from "./define-tool.js";
import { ToolError } from "./errors.js";
import { throwIfCancelled } from "./registry.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const DIALOG_PROMPT_TEXT_MAX_CHARS = 10_000;

const dialogSchema = z.strictObject({
    type             : z.string().describe("Dialog type: alert, confirm, prompt or beforeunload."),
    message          : z.string().describe("Dialog message, clipped to 2000 characters."),
    defaultPrompt    : z.string().optional().describe("Default prompt text, present only for prompts with one."),
    url              : z.string().describe("URL of the page that opened the dialog."),
    hasBrowserHandler: z.boolean().describe("Whether the browser has its own handler for the dialog."),
});

const historySchema = z.strictObject({
    type    : z.string().describe("Dialog type."),
    message : z.string().describe("Dialog message, clipped to 200 characters."),
    url     : z.string().describe("URL of the page that opened the dialog."),
    resolved: z.enum(["accept", "dismiss", "policy", "closed"]).describe("How the dialog was resolved."),
    at      : z.string().describe("ISO time when the dialog was resolved."),
});

export const pageDialogs = defineTool({
    name       : "page_dialogs",
    closedWorld: true,
    description:
        "See and resolve JavaScript dialogs (alert, confirm, prompt, beforeunload) of a tab, or set an automatic policy.",
    access: (args: unknown) => {
        const { action, policy } = args as { action?: unknown; policy?: unknown };

        return (action === undefined || action === "status") && policy === undefined
            ? "read"
            : "mutate";
    },
    input: z.strictObject({
        tab       : tabSchema,
        action    : z.enum(["status", "accept", "dismiss"]).optional().describe("What to do. Defaults to status."),
        promptText: z.string().max(DIALOG_PROMPT_TEXT_MAX_CHARS).optional().describe("Text for a prompt, up to 10000 characters."),
        policy    : z.enum(["none", "accept", "dismiss"]).optional().describe("Automatic handling for dialogs that open later. Defaults to none and is cleared on reset."),
    }),
    output: z.strictObject({
        tab    : z.string().describe("Tab id."),
        open   : dialogSchema.nullable().describe("The currently open dialog, null when there is none."),
        policy : z.enum(["none", "accept", "dismiss"]).describe("Automatic handling policy of the tab."),
        effect : z.string().describe("Short summary of what happened."),
        history: z.array(historySchema).describe("Recently resolved dialogs, oldest first."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        throwIfCancelled(context.signal);

        await context.dialogs.ensure(targetId);

        const action = args.action ?? "status";

        if (args.promptText !== undefined && action !== "accept") {
            throw new ToolError("promptText is only accepted with action accept.");
        }

        if (args.policy !== undefined) context.dialogs.setPolicy(targetId, args.policy);

        let effect: string;

        if (action === "status") {
            effect = context.dialogs.open(targetId) === undefined
                ? "No dialog is open in this tab."
                : "A dialog is open in this tab.";
        } else {
            const accept = action === "accept";
            const result = await context.dialogs.resolve(targetId, accept, args.promptText);

            if (result.handled) {
                effect = accept
                    ? "The dialog was accepted."
                    : "The dialog was dismissed.";
            } else if (result.stale) {
                effect = "The dialog is already gone from the page. Its record was cleared.";
            } else {
                effect = "No dialog is open in this tab. Nothing was done.";
            }
        }

        const open = context.dialogs.open(targetId);

        return {
            tab    : targetId,
            open   : open === undefined ? null : { ...open },
            policy : context.dialogs.policyOf(targetId),
            effect,
            history: context.dialogs.historyOf(targetId),
        };
    },
});
