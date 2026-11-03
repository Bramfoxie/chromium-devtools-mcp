import type { Config } from "../config/index.js";
import { describeUrlHost, isRestricted, isUrlAllowed } from "../safety/index.js";

export type SafetyAccess = "read" | "mutate";

export interface SafetyTarget {
    url?    : string;
    pattern?: string;
}

export interface SafetyFrame {
    frameId: string;
    url    : string;
    origin?: string;
}

export type SafetyDecision = { allowed: true } | { allowed: false; reason: string; hint: string };

export interface SafetyRequest {
    tool      : string;
    access    : SafetyAccess;
    config    : Config;
    target?   : SafetyTarget;
    tabUrl?   : string;
    frame?    : SafetyFrame;
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

    const domains = request.config.safety.allowedDomains;

    if (request.access === "mutate" && isRestricted(domains)) {
        const outside = outsideDomains(request, domains);

        if (outside !== undefined) return outside;
    }

    return { allowed: true };
}

const ADD_DOMAIN_HINT = "Use an allowed domain, or ask the owner to add it to safety.allowedDomains.";

function domainRefusal(subject: string, url: string, hint = ADD_DOMAIN_HINT): SafetyDecision {
    return {
        allowed: false,
        reason : `${subject} ${describeUrlHost(url)}, which is outside safety.allowedDomains.`,
        hint,
    };
}

function outsideDomains(
    request: SafetyRequest,
    domains: readonly string[],
): SafetyDecision | undefined {
    const { tool, target, tabUrl, frame } = request;

    if (target?.url !== undefined && !isUrlAllowed(target.url, domains)) {
        return domainRefusal(`${tool} would open`, target.url);
    }

    if (tabUrl !== undefined && !isUrlAllowed(tabUrl, domains)) {
        return domainRefusal(
            `${tool} acts on a tab that shows`,
            tabUrl,
            "Navigate the tab to an allowed domain with page_navigate first.",
        );
    }

    const frameUrl = frame?.origin ?? frame?.url;

    if (frameUrl !== undefined && !isInheritedFrame(frameUrl) && !isUrlAllowed(frameUrl, domains)) {
        return domainRefusal(`${tool} acts inside a frame from`, frameUrl);
    }

    return undefined;
}

function isInheritedFrame(url: string): boolean {
    return url === "about:blank" || url === "about:srcdoc";
}
