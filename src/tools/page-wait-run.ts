import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import type { ToolContext } from "./define-tool.js";
import { ToolError } from "./errors.js";
import { exceptionText } from "./js-evaluate.js";
import { throwIfCancelled } from "./registry.js";
import { WAIT_MARGIN_MAX_MS, WAIT_CANCEL_TIMEOUT_MS, WAIT_READ_TIMEOUT_MS, WAIT_NETWORK_IDLE_MS } from "./page-wait-limits.js";
import { cancelWaitScript } from "./page-wait-scripts.js";

const waitResultSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.object({
            met   : z.boolean(),
            detail: z.unknown(),
        }).optional(),
    }),
});

interface WaitOutcome {
    met   : boolean;
    detail: unknown;
}

export function waitOutcomeOf(value: unknown): WaitOutcome | undefined {
    const parsed = waitResultSchema.safeParse(value);

    if (!parsed.success || parsed.data.result.value === undefined) return undefined;

    return { met: parsed.data.result.value.met, detail: parsed.data.result.value.detail };
}

export async function runScript(
    context   : ToolContext,
    targetId  : string,
    script    : string,
    timeoutMs : number,
    started   : number,
    token     : string,
    contextId?: number,
): Promise<{ met: boolean; elapsedMs: number; detail: unknown }> {
    const margin = Math.min(WAIT_MARGIN_MAX_MS, Math.floor(timeoutMs / 4) + 1000);
    let result: unknown;
    const cancelInPage = (): Promise<unknown> => context.access.send({
        targetId,
        method: "Runtime.evaluate",
        params: {
            expression: cancelWaitScript(token),
            ...(contextId === undefined ? {} : { contextId }),
        },
        timeoutMs: WAIT_CANCEL_TIMEOUT_MS,
    }).catch(() => undefined);
    const onAbort = (): void => { void cancelInPage(); };

    context.signal.addEventListener("abort", onAbort, { once: true });

    try {
        result = await context.access.send({
            targetId,
            method: "Runtime.evaluate",
            params: {
                expression   : script,
                returnByValue: true,
                awaitPromise : true,
                ...(contextId === undefined ? {} : { contextId }),
            },
            timeoutMs: timeoutMs + margin,
        });
    } catch (error) {
        await cancelInPage();
        await context.access.send({
            targetId,
            method: "Runtime.terminateExecution",
            params: {},
        }).catch(() => undefined);

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
    const result = await access.send({
        targetId,
        method   : "Runtime.evaluate",
        params   : { expression, returnByValue: true },
        timeoutMs: WAIT_READ_TIMEOUT_MS,
    }).catch(() => undefined);
    const parsed = z.object({
        result: z.object({ value: z.unknown().optional() }),
    }).safeParse(result);
    const value = parsed.success ? parsed.data.result.value : undefined;

    return typeof value === "string" ? value : undefined;
}

async function currentUrl(access: DaemonAccess, targetId: string): Promise<string | undefined> {
    return evaluateString(access, targetId, "location.href");
}

export async function waitForUrl(
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

export async function waitForLoadState(
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

const waitWorldSchema = z.object({ executionContextId: z.number() });

export async function waitContext(
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
        await context.access.send({
            targetId,
            method: "Page.createIsolatedWorld",
            params: {
                frameId  : known.frameId,
                worldName: "chromium-devtools-mcp-wait",
            },
        }),
    );

    if (!world.success) {
        throw new ToolError(
            "The browser sent an unexpected response to Page.createIsolatedWorld. Try the call again.",
        );
    }

    return world.data.executionContextId;
}

export async function cancellableSleep(context: ToolContext, ms: number): Promise<void> {
    if (context.signal.aborted) return;

    await Promise.race([
        context.clock.sleep(ms),
        new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    ]);
}
