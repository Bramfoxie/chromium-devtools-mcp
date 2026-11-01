import type { Config } from "../config/index.js";

export type SafetyAccess = "read" | "mutate";

export interface SafetyTarget {
    url?    : string;
    pattern?: string;
}

export type SafetyDecision = { allowed: true } | { allowed: false; reason: string; hint: string };

export interface SafetyRequest {
    tool      : string;
    access    : SafetyAccess;
    config    : Config;
    target?   : SafetyTarget;
    tabUrl?   : string;
    dangerous?: boolean;
}

export function checkSafety(request: SafetyRequest): SafetyDecision {
    if (request.access === "mutate" && request.config.safety.readOnly) {
        return {
            allowed: false,
            reason:
                `${request.tool} changes page or browser state and is refused in read-only mode.`,
            hint: "Run without --read-only to allow changes.",
        };
    }

    return { allowed: true };
}
