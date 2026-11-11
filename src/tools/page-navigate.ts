import { z } from "zod";
import { defineTool } from "./define-tool.js";
import { createDeadline, sendWithin } from "./deadline.js";
import { ensureNoDialog } from "./dialogs.js";
import { DomainRefusal, requireAllowedFinalUrl } from "./final-url.js";
import { ToolError } from "./errors.js";
import { throwIfCancelled } from "./registry.js";
import { resolveTab, tabSchema } from "./tab-target.js";
import { waitUntilSchema } from "./page-navigate-wait.js";
import { currentPage } from "./page-navigate-state.js";
import { navigate, navigateAndWait } from "./page-navigate-load.js";

export const NAVIGATE_DEFAULT_TIMEOUT_MS = 30_000;

export const NAVIGATE_MAX_TIMEOUT_MS = 120_000;

export const pageNavigate = defineTool({
    name: "page_navigate",
    description:
        "Navigate a tab to a URL, go back or forward, reload it, open a history entry, or stop its loading.",
    access: "mutate",
    input : z.strictObject({
        tab         : tabSchema,
        action      : z.enum(["url", "back", "forward", "reload", "stop", "history"]).optional().describe("What to do. Defaults to url."),
        url         : z.string().min(1).max(2048).optional().describe("URL to open, http, https or about:blank. Required for the url action."),
        waitUntil   : waitUntilSchema.optional().describe("Wait for the load event, DOMContentLoaded, or return at once. Defaults to load."),
        timeoutMs   : z.number().int().min(1).max(NAVIGATE_MAX_TIMEOUT_MS).optional().describe(`How long to wait for the page. Defaults to ${NAVIGATE_DEFAULT_TIMEOUT_MS} ms.`),
        historyIndex: z.number().int().min(0).optional().describe("Entry index from page_history. Only for the history action."),
        ignoreCache : z.boolean().optional().describe("Reload ignoring the cache. Only for the reload action."),
    }),
    output: z.strictObject({
        tab           : z.string().describe("Tab id."),
        url           : z.string().describe("Final URL of the tab."),
        title         : z.string().describe("Final title of the tab."),
        status        : z.number().optional().describe("HTTP status of the main document, when observed."),
        waited        : z.enum(["load", "domcontentloaded", "none", "timeout"]).describe("What the tool waited for."),
        navigationType: z.string().describe("The navigation action that ran."),
        readyState    : z.string().optional().describe("Document ready state, reported when the wait timed out."),
    }),
    target: (args) =>
        args.action === undefined || args.action === "url"
            ? args.url === undefined
                ? undefined
                : { url: args.url }
            : undefined,
    tabUrlExempt: (args) => (args.action ?? "url") === "url",
    handler     : async (args, context) => {
        const targetId = resolveTab(args, context);

        const action = args.action ?? "url";

        if (action === "history" && args.historyIndex === undefined) {
            throw new ToolError("The history action needs a historyIndex from page_history.");
        }

        if (args.historyIndex !== undefined && action !== "history") {
            throw new ToolError("historyIndex is only available for the history action.");
        }

        if (args.ignoreCache !== undefined && action !== "reload") {
            throw new ToolError("ignoreCache is only available for the reload action.");
        }

        if (action === "url" && args.url === undefined) {
            throw new ToolError("The url action needs a url to open.");
        }

        const waitUntil = args.waitUntil ?? "load";
        const timeoutMs = args.timeoutMs ?? NAVIGATE_DEFAULT_TIMEOUT_MS;

        throwIfCancelled(context.signal);

        await ensureNoDialog(context.dialogs, targetId);

        const deadline = createDeadline(context.signal, timeoutMs, () => context.clock.now());

        try {
            if (action === "stop") {
                await sendWithin(context.access, deadline, targetId, "Page.stopLoading", {});
                const page = await currentPage(context, targetId);

                await requireAllowedFinalUrl(context, targetId, page.url);

                return {
                    tab           : targetId,
                    url           : page.url,
                    title         : page.title,
                    waited        : "none" as const,
                    navigationType: action,
                };
            }

            if (waitUntil === "none") {
                await navigate(
                    context, deadline, targetId, action, args.url,
                    args.ignoreCache, args.historyIndex,
                );
                const page = await currentPage(context, targetId);

                await requireAllowedFinalUrl(context, targetId, page.url);

                return {
                    tab           : targetId,
                    url           : page.url,
                    title         : page.title,
                    waited        : "none" as const,
                    navigationType: action,
                };
            }

            const state = await navigateAndWait(
                context,
                deadline,
                targetId,
                action,
                args.url,
                args.ignoreCache,
                waitUntil,
                args.historyIndex,
            );
            const page = await currentPage(context, targetId);

            await requireAllowedFinalUrl(context, targetId, page.url);

            const waited: "load" | "domcontentloaded" | "timeout" = state.done ? waitUntil : "timeout";

            return {
                tab           : targetId,
                url           : page.url,
                title         : page.title,
                ...(state.status === undefined ? {} : { status: state.status }),
                waited,
                navigationType: action,
                ...(waited === "timeout" ? { readyState: page.readyState } : {}),
            };
        } catch (error) {
            if (error instanceof DomainRefusal) throw error;

            if (deadline.expired() && !context.signal.aborted) {
                throw new ToolError(
                    `The navigation did not start within ${timeoutMs} ms. The page may still be loading; check it with page_info or raise timeoutMs.`,
                );
            }

            throw error;
        } finally {
            deadline.dispose();
            context.elements.nextGeneration(targetId);
        }
    },
});
