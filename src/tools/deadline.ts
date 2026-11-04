import type { DaemonAccess } from "../mcp/index.js";

export interface Deadline {
    readonly signal: AbortSignal;
    remainingMs(): number;
    expired(): boolean;
    dispose(): void;
}

// The signal aborts on the parent signal or when the budget runs out.
export function createDeadline(
    parent   : AbortSignal,
    timeoutMs: number,
    now      : () => number = Date.now,
): Deadline {
    const controller = new AbortController();
    const endsAt = now() + timeoutMs;
    let timedOut = false;
    const onParentAbort = () => controller.abort();
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onParentAbort, { once: true });

    return {
        signal     : controller.signal,
        remainingMs: () => Math.max(1, endsAt - now()),
        expired    : () => timedOut || now() >= endsAt,
        dispose    : () => {
            clearTimeout(timer);
            parent.removeEventListener("abort", onParentAbort);
        },
    };
}

export function sendWithin(
    access  : DaemonAccess,
    deadline: Deadline,
    targetId: string,
    method  : string,
    params? : Record<string, unknown>,
): Promise<unknown> {
    return access.send({
        targetId,
        method,
        params,
        timeoutMs: deadline.remainingMs(),
        signal   : deadline.signal,
    });
}
