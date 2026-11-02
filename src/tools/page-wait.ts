import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { compileUrlPattern, testUrlPattern } from "./capture/network-log.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { MAX_FRAME_LENGTH } from "./element-target.js";
import { ToolError } from "./errors.js";
import { exceptionText } from "./js-evaluate.js";
import { throwIfCancelled } from "./registry.js";

export const WAIT_DEFAULT_TIMEOUT_MS = 10_000;

export const WAIT_MAX_TIMEOUT_MS = 120_000;

export const WAIT_DEFAULT_POLL_MS = 100;

export const WAIT_MIN_POLL_MS = 50;

export const WAIT_MAX_SLEEP_MS = 60_000;

export const WAIT_NETWORK_IDLE_MS = 500;

export const WAIT_MAX_URL_CHARS = 2048;

export const WAIT_MAX_SELECTOR_CHARS = 1024;

export const WAIT_MAX_TEXT_CHARS = 1024;

export const WAIT_MAX_EXPRESSION_CHARS = 100_000;

const conditionSchema = z.strictObject({
    selector  : z.string().min(1).max(WAIT_MAX_SELECTOR_CHARS).optional().describe("CSS selector to wait for."),
    state     : z.enum(["attached", "visible", "hidden", "detached"]).optional().describe("Selector state. Defaults to visible."),
    text      : z.string().min(1).max(WAIT_MAX_TEXT_CHARS).optional().describe("Substring of the visible page text to wait for."),
    url       : z.string().min(1).max(WAIT_MAX_URL_CHARS).optional().describe("URL substring to wait for."),
    urlRegex  : z.string().min(1).max(200).optional().describe("URL regular expression to wait for, up to 200 characters."),
    loadState : z.enum(["load", "domcontentloaded", "networkidle"]).optional().describe("Page load state to wait for."),
    expression: z.string().min(1).max(WAIT_MAX_EXPRESSION_CHARS).optional().describe("JavaScript expression that must become truthy."),
    ms        : z.number().int().min(1).max(WAIT_MAX_SLEEP_MS).optional().describe("Plain sleep in ms, up to 60000."),
});

export type WaitCondition = z.infer<typeof conditionSchema>;

export const WAIT_REGISTRY = "__chromiumDevtoolsMcpWaits";

function waitPrelude(token: string): string {
    return `const waits = (globalThis[${JSON.stringify(WAIT_REGISTRY)}] ??= new Map());
  let cancelled = false;
  let timer;
  let wake;
  const nap = (ms) => new Promise((resolve) => {
    if (cancelled) return resolve();
    wake = resolve;
    timer = setTimeout(resolve, ms);
  });
  waits.set(${JSON.stringify(token)}, () => {
    cancelled = true;
    clearTimeout(timer);
    if (wake) wake();
  });`;
}

export function cancelWaitScript(token: string): string {
    return `(() => { const stop = globalThis[${JSON.stringify(WAIT_REGISTRY)}]?.get(${JSON.stringify(token)}); if (stop) stop(); })()`;
}

export interface SelectorDetail {
    matched: number;
    visible: number;
}

export function selectorScript(
    selector : string,
    state    : "attached" | "visible" | "hidden" | "detached",
    pollMs   : number,
    timeoutMs: number,
    pierce?  : boolean,
    token    : string = "wait",
): string {
    const matcher = JSON.stringify(selector);
    const want = JSON.stringify(state);
    const collect = pierce === true
        ? `const collect = (root, out) => {
      for (const el of root.querySelectorAll(selector)) out.push(el);
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) collect(el.shadowRoot, out);
      }
    };
    const found = [];
    collect(document, found);`
        : `const found = [...document.querySelectorAll(selector)];`;

    return `(async () => {
  ${waitPrelude(token)}
  const selector = ${matcher};
  const want = ${want};
  const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
  const query = () => {
    ${collect}
    const visible = found.filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 &&
        getComputedStyle(el).visibility !== "hidden";
    });
    return { matched: found.length, visible: visible.length };
  };
  const met = (detail) => want === "attached" ? detail.matched > 0
    : want === "visible" ? detail.visible > 0
    : want === "hidden" ? detail.matched === 0 || detail.visible === 0
    : detail.matched === 0;
  let detail = query();
  try {
    while (!cancelled && Date.now() < deadline) {
      if (met(detail)) return { met: true, detail };
      await nap(${JSON.stringify(pollMs)});
      if (cancelled || Date.now() >= deadline) break;
      detail = query();
    }
    return { met: met(detail), detail };
  } finally {
    clearTimeout(timer);
    waits.delete(${JSON.stringify(token)});
  }
})()`;
}

export function textScript(
    text     : string,
    selector : string | undefined,
    pollMs   : number,
    timeoutMs: number,
    token    : string = "wait",
): string {
    const needle = JSON.stringify(text);
    const scope = JSON.stringify(selector ?? "");

    return `(async () => {
  ${waitPrelude(token)}
  const needle = ${needle};
  const scope = ${scope};
  const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
  const read = () => {
    const root = scope === "" ? document.body : document.querySelector(scope);
    const haystack = root === null || root === undefined ? "" : (root.innerText ?? "");
    return { length: haystack.length, found: haystack.includes(needle) };
  };
  try {
    for (;;) {
      const detail = read();
      if (detail.found) return { met: true, detail };
      if (cancelled || Date.now() >= deadline) return { met: false, detail };
      await nap(${JSON.stringify(pollMs)});
    }
  } finally {
    clearTimeout(timer);
    waits.delete(${JSON.stringify(token)});
  }
})()`;
}

export function expressionScript(expression: string, pollMs: number, timeoutMs: number, token: string = "wait"): string {
    return `(async () => {
  ${waitPrelude(token)}
  const check = () => (${expression});
  const deadline = Date.now() + ${JSON.stringify(timeoutMs)};
  let last = undefined;
  try {
    for (;;) {
      try {
        last = await check();
      } catch (error) {
        last = undefined;
      }
      if (last) return { met: true, detail: { truthy: true } };
      if (cancelled || Date.now() >= deadline) return { met: false, detail: { truthy: false } };
      await nap(${JSON.stringify(pollMs)});
    }
  } finally {
    clearTimeout(timer);
    waits.delete(${JSON.stringify(token)});
  }
})()`;
}

const waitResultSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.object({
            met   : z.boolean(),
            detail: z.unknown(),
        }).optional(),
    }),
});

export interface WaitOutcome {
    met   : boolean;
    detail: unknown;
}

export function waitOutcomeOf(value: unknown): WaitOutcome | undefined {
    const parsed = waitResultSchema.safeParse(value);

    if (!parsed.success || parsed.data.result.value === undefined) return undefined;

    return { met: parsed.data.result.value.met, detail: parsed.data.result.value.detail };
}

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

async function runScript(
    context   : ToolContext,
    targetId  : string,
    script    : string,
    timeoutMs : number,
    started   : number,
    token     : string,
    contextId?: number,
): Promise<{ met: boolean; elapsedMs: number; detail: unknown }> {
    const margin = Math.min(5000, Math.floor(timeoutMs / 4) + 1000);
    let result: unknown;
    const cancelInPage = (): Promise<unknown> => context.access.send(
        targetId,
        "Runtime.evaluate",
        {
            expression: cancelWaitScript(token),
            ...(contextId === undefined ? {} : { contextId }),
        },
        5000,
    ).catch(() => undefined);
    const onAbort = (): void => { void cancelInPage(); };

    context.signal.addEventListener("abort", onAbort, { once: true });

    try {
        result = await context.access.send(
            targetId,
            "Runtime.evaluate",
            {
                expression   : script,
                returnByValue: true,
                awaitPromise : true,
                ...(contextId === undefined ? {} : { contextId }),
            },
            timeoutMs + margin,
        );
    } catch (error) {
        await cancelInPage();
        await context.access.send(targetId, "Runtime.terminateExecution", {}).catch(() => undefined);

        throw error;
    } finally {
        context.signal.removeEventListener("abort", onAbort);
    }

    const failure = z.object({
        exceptionDetails: z.object({
            text     : z.string(),
            exception: z.object({
                type       : z.string(),
                description: z.string().optional(),
            }).optional(),
        }),
    }).safeParse(result);

    if (failure.success) {
        throw new ToolError(
            `The wait condition threw in the page: ${exceptionText(failure.data.exceptionDetails).replace(/\.$/, "")}. ` +
            "Fix the selector or expression and call page_wait again.",
        );
    }

    const outcome = waitOutcomeOf(result);

    if (outcome === undefined) {
        throw new ToolError(
            "The browser sent an unexpected response to Runtime.evaluate. Try the call again.",
        );
    }

    return { met: outcome.met, elapsedMs: context.clock.now() - started, detail: outcome.detail };
}

async function evaluateString(
    access    : DaemonAccess,
    targetId  : string,
    expression: string,
): Promise<string | undefined> {
    const result = await access.send(
        targetId,
        "Runtime.evaluate",
        { expression, returnByValue: true },
        5000,
    ).catch(() => undefined);
    const parsed = z.object({
        result: z.object({ value: z.unknown().optional() }),
    }).safeParse(result);
    const value = parsed.success ? parsed.data.result.value : undefined;

    return typeof value === "string" ? value : undefined;
}

async function currentUrl(access: DaemonAccess, targetId: string): Promise<string | undefined> {
    return evaluateString(access, targetId, "location.href");
}

async function waitForUrl(
    context  : ToolContext,
    targetId : string,
    matches  : (url: string) => boolean,
    condition: string,
    timeoutMs: number,
    pollMs   : number,
    started  : number,
): Promise<{ met: boolean; elapsedMs: number; detail: unknown }> {
    for (;;) {
        throwIfCancelled(context.signal);

        const url = await currentUrl(context.access, targetId);

        if (url !== undefined && matches(url)) {
            return { met: true, elapsedMs: context.clock.now() - started, detail: { url } };
        }

        if (context.clock.now() - started >= timeoutMs) {
            return {
                met      : false,
                elapsedMs: context.clock.now() - started,
                detail   : { url: url ?? "", condition },
            };
        }

        await context.clock.sleep(pollMs);
    }
}

async function waitForLoadState(
    context  : ToolContext,
    targetId : string,
    state    : "load" | "domcontentloaded" | "networkidle",
    timeoutMs: number,
    pollMs   : number,
    started  : number,
): Promise<{ met: boolean; elapsedMs: number; detail: unknown }> {
    if (state === "networkidle") {
        await context.capture.ensureNetwork(targetId);
    }

    const quietFrom = context.clock.now();
    const observedIdle = (): number => Math.min(
        context.capture.idleNetworkMs(targetId, quietFrom),
        context.clock.now() - quietFrom,
    );

    for (;;) {
        throwIfCancelled(context.signal);

        if (state === "networkidle") {
            const idle = observedIdle();

            if (idle >= WAIT_NETWORK_IDLE_MS) {
                return {
                    met      : true,
                    elapsedMs: context.clock.now() - started,
                    detail   : { idleMs: idle },
                };
            }
        } else {
            const ready = await readyState(context.access, targetId);
            const met = state === "load" ? ready === "complete" : ready === "complete" || ready === "interactive";

            if (met) {
                return {
                    met      : true,
                    elapsedMs: context.clock.now() - started,
                    detail   : { readyState: ready ?? "unknown" },
                };
            }

            if (context.clock.now() - started >= timeoutMs) {
                return {
                    met      : false,
                    elapsedMs: context.clock.now() - started,
                    detail   : { readyState: ready ?? "unknown" },
                };
            }
        }

        if (context.clock.now() - started >= timeoutMs) {
            const detail = state === "networkidle"
                ? { idleMs: observedIdle() }
                : { readyState: (await readyState(context.access, targetId)) ?? "unknown" };

            return { met: false, elapsedMs: context.clock.now() - started, detail };
        }

        await context.clock.sleep(pollMs);
    }
}

async function readyState(access: DaemonAccess, targetId: string): Promise<string | undefined> {
    return evaluateString(access, targetId, "document.readyState");
}

export const pageWait = defineTool({
    name: "page_wait",
    description:
        "Wait for a selector, text, URL, load state or expression in a tab. A timeout is a result with met false, not an error. The expression condition runs arbitrary page JavaScript.",
    access: (args: unknown) => {
        const expression = (args as { expression?: unknown } | null)?.expression;

        return expression === undefined ? "read" : "mutate";
    },
    input: z.strictObject({
        tab       : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        selector  : conditionSchema.shape.selector,
        state     : conditionSchema.shape.state,
        text      : conditionSchema.shape.text,
        url       : conditionSchema.shape.url,
        urlRegex  : conditionSchema.shape.urlRegex,
        loadState : conditionSchema.shape.loadState,
        expression: conditionSchema.shape.expression,
        ms        : conditionSchema.shape.ms,
        timeoutMs : z.number().int().min(1).max(WAIT_MAX_TIMEOUT_MS).optional().describe("How long to wait. Defaults to 10000 ms."),
        pollMs    : z.number().int().min(WAIT_MIN_POLL_MS).max(5000).optional().describe("Poll interval in ms. Defaults to 100."),
        pierce    : z.boolean().optional().describe("Match the selector through open shadow roots. Only with a selector condition. Defaults to false."),
        frame     : z.string().min(1).max(MAX_FRAME_LENGTH).optional().describe("Frame id from dom_snapshot to wait in. Only with a selector condition. Defaults to the main frame."),
    }),
    output: z.strictObject({
        tab      : z.string().describe("Tab id."),
        met      : z.boolean().describe("Whether the condition was met before the timeout."),
        condition: z.string().describe("The condition that was waited for."),
        elapsedMs: z.number().describe("Milliseconds waited."),
        detail   : z.unknown().describe("Debugging detail: match counts, the URL, or the ready state."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

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

            // A plain sleep is not a page wait: it always runs its full
            // length instead of being capped by the default tool timeout.
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
            let pattern: RegExp | undefined;

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

const waitWorldSchema = z.object({ executionContextId: z.number() });

async function waitContext(
    context : ToolContext,
    targetId: string,
    frame   : string,
): Promise<number> {
    await context.frames.ensure(targetId).catch(() => undefined);

    const known = context.frames.frameOf(targetId, frame);

    if (known === undefined) {
        await context.frames.refresh(targetId).catch(() => undefined);

        const found = context.frames.frameOf(targetId, frame);

        if (found === undefined) {
            throw new ToolError(
                `No frame ${JSON.stringify(frame)} exists in this tab. List frames with dom_snapshot and try again.`,
            );
        }

        return waitContext(context, targetId, found.frameId);
    }

    const world = waitWorldSchema.safeParse(
        await context.access.send(targetId, "Page.createIsolatedWorld", {
            frameId  : known.frameId,
            worldName: "chromium-devtools-mcp-wait",
        }),
    );

    if (!world.success) {
        throw new ToolError(
            "The browser sent an unexpected response to Page.createIsolatedWorld. Try the call again.",
        );
    }

    return world.data.executionContextId;
}

async function cancellableSleep(context: ToolContext, ms: number): Promise<void> {
    if (context.signal.aborted) return;

    await Promise.race([
        context.clock.sleep(ms),
        new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    ]);
}
