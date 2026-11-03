import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type UrlPattern, compileUrlPattern, testUrlPattern } from "./capture/url-pattern.js";
import { defineTool } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { MAX_FRAME_LENGTH } from "./element-target.js";
import { ToolError } from "./errors.js";
import { throwIfCancelled } from "./registry.js";
import { resolveTab, tabSchema } from "./tab-target.js";
import { WAIT_DEFAULT_TIMEOUT_MS, WAIT_MAX_TIMEOUT_MS, WAIT_DEFAULT_POLL_MS, WAIT_MIN_POLL_MS, WAIT_MAX_POLL_MS, WAIT_MAX_SLEEP_MS, WAIT_MAX_URL_CHARS, WAIT_MAX_SELECTOR_CHARS, WAIT_MAX_TEXT_CHARS, WAIT_MAX_EXPRESSION_CHARS } from "./page-wait-limits.js";
import { expressionScript, selectorScript, textScript } from "./page-wait-scripts.js";
import { cancellableSleep, runScript, waitContext, waitForLoadState, waitForUrl } from "./page-wait-run.js";

const conditionSchema = z.strictObject({
    selector  : z.string().min(1).max(WAIT_MAX_SELECTOR_CHARS).optional().describe("CSS selector to wait for."),
    state     : z.enum(["attached", "visible", "hidden", "detached"]).optional().describe("Selector state. Defaults to visible."),
    text      : z.string().min(1).max(WAIT_MAX_TEXT_CHARS).optional().describe("Substring of the visible page text to wait for."),
    url       : z.string().min(1).max(WAIT_MAX_URL_CHARS).optional().describe("URL substring to wait for."),
    urlRegex  : z.string().min(1).max(200).optional().describe("URL regular expression to wait for, up to 200 characters. A match that takes longer than 50 ms is stopped and fails the call."),
    loadState : z.enum(["load", "domcontentloaded", "networkidle"]).optional().describe("Page load state to wait for."),
    expression: z.string().min(1).max(WAIT_MAX_EXPRESSION_CHARS).optional().describe("JavaScript expression that must become truthy."),
    ms        : z.number().int().min(1).max(WAIT_MAX_SLEEP_MS).optional().describe("Plain sleep in ms, up to 60000."),
});

type WaitCondition = z.infer<typeof conditionSchema>;

export function checkConditions(args: WaitCondition): string {
    const keys = [
        args.text === undefined && args.selector !== undefined,
        args.text !== undefined,
        args.url !== undefined,
        args.urlRegex !== undefined,
        args.loadState !== undefined,
        args.expression !== undefined,
        args.ms !== undefined,
    ].filter(Boolean).length;

    if (keys === 0) {
        throw new ToolError(
            "Provide exactly one wait condition: selector, text, url, urlRegex, loadState, expression or ms.",
        );
    }

    if (keys > 1) {
        throw new ToolError("Provide exactly one wait condition, not several.");
    }

    if (args.text !== undefined && args.selector !== undefined) return "text";
    if (args.selector !== undefined) return "selector";
    if (args.text !== undefined) return "text";
    if (args.url !== undefined) return "url";
    if (args.urlRegex !== undefined) return "urlRegex";
    if (args.loadState !== undefined) return "loadState";
    if (args.expression !== undefined) return "expression";

    return "ms";
}

function describeCondition(args: WaitCondition, kind: string): string {
    switch (kind) {
        case "selector":
            return `selector ${JSON.stringify(args.selector)} ${args.state ?? "visible"}`;
        case "text":
            return args.selector === undefined
                ? `text ${JSON.stringify(args.text)}`
                : `text ${JSON.stringify(args.text)} in ${JSON.stringify(args.selector)}`;
        case "url":
            return `url containing ${JSON.stringify(args.url)}`;
        case "urlRegex":
            return `url matching ${JSON.stringify(args.urlRegex)}`;
        case "loadState":
            return `load state ${args.loadState}`;
        case "expression":
            return "expression becoming truthy";
        default:
            return `sleep of ${args.ms} ms`;
    }
}

export const pageWait = defineTool({
    name: "page_wait",
    description:
        "Wait for a selector, text, URL, load state or expression in a tab. A timeout is a result with met false, not an error. The expression condition runs arbitrary page JavaScript.",
    access: (args: unknown) => {
        const expression = (args as { expression?: unknown } | null)?.expression;

        return expression === undefined ? "read" : "mutate";
    },
    dangerous: (args) => args.expression !== undefined,
    summarize: (args) => `It runs this script in the page: ${(args.expression ?? "").slice(0, 300)}`,
    input    : z.strictObject({
        tab       : tabSchema,
        selector  : conditionSchema.shape.selector,
        state     : conditionSchema.shape.state,
        text      : conditionSchema.shape.text,
        url       : conditionSchema.shape.url,
        urlRegex  : conditionSchema.shape.urlRegex,
        loadState : conditionSchema.shape.loadState,
        expression: conditionSchema.shape.expression,
        ms        : conditionSchema.shape.ms,
        timeoutMs : z.number().int().min(1).max(WAIT_MAX_TIMEOUT_MS).optional().describe(`How long to wait. Defaults to ${WAIT_DEFAULT_TIMEOUT_MS} ms.`),
        pollMs    : z.number().int().min(WAIT_MIN_POLL_MS).max(WAIT_MAX_POLL_MS).optional().describe("Poll interval in ms. Defaults to 100."),
        pierce    : z.boolean().optional().describe("Match the selector through open shadow roots. Only with a selector condition. Defaults to false."),
        frame     : z.string().min(1).max(MAX_FRAME_LENGTH).optional().describe("Frame id from dom_snapshot to wait in. Only with a selector condition. Defaults to the main frame."),
    }),
    output: z.strictObject({
        tab      : z.string().describe("Tab id."),
        met      : z.boolean().describe("Whether the condition was met before the timeout."),
        condition: z.string().describe("The condition that was waited for."),
        elapsedMs: z.number().describe("Milliseconds waited."),
        detail   : z.unknown().describe("Debugging detail: match counts, the URL, or the ready state. A pierce selector wait visits at most 20000 elements and sets capped in the detail when it stopped early."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        const conditionArgs: WaitCondition = {
            selector  : args.selector,
            state     : args.state,
            text      : args.text,
            url       : args.url,
            urlRegex  : args.urlRegex,
            loadState : args.loadState,
            expression: args.expression,
            ms        : args.ms,
        };
        const kind = checkConditions(conditionArgs);

        if (args.selector !== undefined && kind !== "selector" && kind !== "text") {
            throw new ToolError("selector only combines with text, not with other conditions.");
        }

        if ((args.pierce !== undefined || args.frame !== undefined) && kind !== "selector") {
            throw new ToolError("pierce and frame only combine with a selector condition.");
        }

        const timeoutMs = args.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS;
        const pollMs = args.pollMs ?? WAIT_DEFAULT_POLL_MS;
        const condition = describeCondition(conditionArgs, kind);
        const started = context.clock.now();
        const token = randomUUID();

        if (kind === "ms") {
            throwIfCancelled(context.signal);

            const sleepMs = args.ms ?? 0;

            await cancellableSleep(context, sleepMs);
            throwIfCancelled(context.signal);

            return {
                tab      : targetId,
                met      : true,
                condition,
                elapsedMs: context.clock.now() - started,
                detail   : { sleptMs: sleepMs },
            };
        }

        await ensureNoDialog(context.dialogs, targetId);
        throwIfCancelled(context.signal);

        if (kind === "selector") {
            const contextId = args.frame === undefined
                ? undefined
                : await waitContext(context, targetId, args.frame);

            return {
                tab: targetId,
                condition,
                ...await runScript(
                    context,
                    targetId,
                    selectorScript(
                        args.selector ?? "",
                        args.state ?? "visible",
                        pollMs,
                        timeoutMs,
                        args.pierce,
                        token,
                    ),
                    timeoutMs,
                    started,
                    token,
                    contextId,
                ),
            };
        }

        if (kind === "text") {
            return {
                tab: targetId,
                condition,
                ...await runScript(
                    context,
                    targetId,
                    textScript(args.text ?? "", args.selector, pollMs, timeoutMs, token),
                    timeoutMs,
                    started,
                    token,
                ),
            };
        }

        if (kind === "expression") {
            return {
                tab: targetId,
                condition,
                ...await runScript(
                    context,
                    targetId,
                    expressionScript(args.expression ?? "false", pollMs, timeoutMs, token),
                    timeoutMs,
                    started,
                    token,
                ),
            };
        }

        if (kind === "url" || kind === "urlRegex") {
            let pattern: UrlPattern | undefined;

            if (args.urlRegex !== undefined) {
                try {
                    pattern = compileUrlPattern(args.urlRegex);
                } catch (error) {
                    throw new ToolError(
                        error instanceof Error ? error.message : "The pattern is not a valid regular expression.",
                    );
                }
            }

            const needle = args.url;

            return {
                tab: targetId,
                condition,
                ...await waitForUrl(
                    context,
                    targetId,
                    (url) => {
                        if (pattern !== undefined) {
                            return testUrlPattern(pattern, url);
                        }

                        return needle !== undefined && url.includes(needle);
                    },
                    condition,
                    timeoutMs,
                    pollMs,
                    started,
                ),
            };
        }

        return {
            tab: targetId,
            condition,
            ...await waitForLoadState(
                context,
                targetId,
                args.loadState ?? "load",
                timeoutMs,
                pollMs,
                started,
            ),
        };
    },
});
