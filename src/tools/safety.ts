import type { Config } from "../config/index.js";
import {
    describeBlock,
    describeUrlHost,
    domainBlock,
    isPolicyActive,
    navigationBlock,
    type Block,
    type DomainPolicy,
} from "../safety/index.js";

export type SafetyAccess = "read" | "mutate";

export interface SafetyTarget {
    url?: string;
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

    const domains = request.config.safety;

    if (request.access === "mutate") {
        const { tool, target } = request;
        const opening = target?.url === undefined
            ? undefined
            : navigationBlock(target.url, domains);

        if (target?.url !== undefined && opening !== undefined) {
            return domainRefusal(`${tool} would open`, target.url, opening);
        }
    }

    if (request.access === "mutate" && isPolicyActive(domains)) {
        const outside = outsideDomains(request, domains);

        if (outside !== undefined) return outside;
    }

    return { allowed: true };
}

function domainRefusal(
    subject: string,
    url    : string,
    block  : Block,
    hint?  : string,
): SafetyDecision {
    const described = describeBlock(block);

    return {
        allowed: false,
        reason : `${subject} ${describeUrlHost(url)}, ${described.reason}.`,
        hint   : hint ?? described.hint,
    };
}

function outsideDomains(
    request: SafetyRequest,
    domains: DomainPolicy,
): SafetyDecision | undefined {
    const { tool, tabUrl, frame } = request;

    const tabBlock = tabUrl === undefined ? undefined : domainBlock(tabUrl, domains);

    if (tabUrl !== undefined && tabBlock !== undefined) {
        return domainRefusal(
            `${tool} acts on a tab that shows`,
            tabUrl,
            tabBlock,
            tabBlock === "outside-allowed"
                ? "Navigate the tab to an allowed domain with page_navigate first."
                : undefined,
        );
    }

    const frameUrl = frame?.origin ?? frame?.url;
    const frameBlock = frameUrl === undefined || isInheritedFrame(frameUrl)
        ? undefined
        : domainBlock(frameUrl, domains);

    if (frameUrl !== undefined && frameBlock !== undefined) {
        return domainRefusal(`${tool} acts inside a frame from`, frameUrl, frameBlock);
    }

    return undefined;
}

function isInheritedFrame(url: string): boolean {
    return url === "about:blank" || url === "about:srcdoc";
}
