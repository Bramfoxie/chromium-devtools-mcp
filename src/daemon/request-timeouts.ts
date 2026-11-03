import type { requestParamSchemas } from "./wire.js";

export type RequestMethod = keyof typeof requestParamSchemas;

export type TimeoutClass = "plain" | "cdp-bound" | "multi-step";

const TIMEOUT_CLASSES = {
    "daemon.status"  : "plain",
    "daemon.stop"    : "plain",
    "session.open"   : "plain",
    "session.list"   : "plain",
    "permission.set" : "cdp-bound",
    "tab.create"     : "cdp-bound",
    "tab.list"       : "multi-step",
    "tab.claim"      : "plain",
    "tab.close"      : "plain",
    "frame.list"     : "multi-step",
    "cdp.send"       : "cdp-bound",
    "cdp.subscribe"  : "plain",
    "cdp.unsubscribe": "plain",
} as const satisfies Record<RequestMethod, TimeoutClass>;

export function timeoutClassOf(method: string): TimeoutClass {
    return Object.hasOwn(TIMEOUT_CLASSES, method)
        ? TIMEOUT_CLASSES[method as RequestMethod]
        : "plain";
}

export function declaredTimeoutMs(params: unknown): number | undefined {
    if (typeof params !== "object" || params === null || !("timeoutMs" in params)) return undefined;

    const { timeoutMs } = params;

    return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? timeoutMs : undefined;
}
