import { isHostAllowed, isUrlAllowed } from "./allowlist.js";
import { isPrivateHost } from "./private-network.js";

export interface DomainPolicy {
    allowedDomains: readonly string[];
    deniedDomains : readonly string[];
}

export interface NavigationPolicy extends DomainPolicy {
    allowPrivateNetworks: boolean;
}

export type Block = "outside-allowed" | "denied" | "private" | "resolved-private";

const WEB_PROTOCOLS = new Set(["http:", "https:"]);

export function isPolicyActive(policy: DomainPolicy): boolean {
    return policy.allowedDomains.length > 0 || policy.deniedDomains.length > 0;
}

function webUrl(url: string): URL | undefined {
    try {
        const parsed = new URL(url);

        return WEB_PROTOCOLS.has(parsed.protocol) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function portOf(parsed: URL): string {
    if (parsed.port !== "") return parsed.port;

    return parsed.protocol === "http:" ? "80" : "443";
}

function isDenied(parsed: URL, policy: DomainPolicy): boolean {
    return policy.deniedDomains.length > 0
        && isHostAllowed(parsed.hostname, policy.deniedDomains, portOf(parsed));
}

export function domainBlock(url: string, policy: DomainPolicy): Block | undefined {
    if (url.toLowerCase() === "about:blank") return undefined;

    const parsed = webUrl(url);

    if (parsed !== undefined && isDenied(parsed, policy)) return "denied";

    if (policy.allowedDomains.length > 0 && !isUrlAllowed(url, policy.allowedDomains)) {
        return "outside-allowed";
    }

    return undefined;
}

export function hostBlock(host: string, policy: DomainPolicy): Block | undefined {
    if (policy.deniedDomains.length > 0 && isHostAllowed(host, policy.deniedDomains)) {
        return "denied";
    }

    if (policy.allowedDomains.length > 0 && !isHostAllowed(host, policy.allowedDomains)) {
        return "outside-allowed";
    }

    return undefined;
}

// A host that an allowedDomains entry names is allowed even on a private network.
export function navigationBlock(url: string, policy: NavigationPolicy): Block | undefined {
    const block = domainBlock(url, policy);

    if (block !== undefined || policy.allowPrivateNetworks) return block;

    const parsed = webUrl(url);

    if (parsed === undefined || !isPrivateHost(parsed.hostname)) return undefined;

    const named = policy.allowedDomains.length > 0
        && isHostAllowed(parsed.hostname, policy.allowedDomains, portOf(parsed));

    return named ? undefined : "private";
}

// The host to look up when a public name has to be checked for a private address.
export function hostToResolve(url: string, policy: NavigationPolicy): string | undefined {
    if (policy.allowPrivateNetworks) return undefined;

    const parsed = webUrl(url);

    if (parsed === undefined) return undefined;

    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");

    if (host === "" || host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return undefined;

    const named = policy.allowedDomains.length > 0
        && isHostAllowed(parsed.hostname, policy.allowedDomains, portOf(parsed));

    return named ? undefined : host;
}

const REASONS: Record<Block, { reason: string; hint: string }> = {
    "outside-allowed": {
        reason: "which is outside safety.allowedDomains",
        hint  : "Use an allowed domain, or ask the owner to add it to safety.allowedDomains.",
    },
    denied: {
        reason: "which is blocked by safety.deniedDomains",
        hint  : "Use another site, or ask the owner to remove it from safety.deniedDomains.",
    },
    "resolved-private": {
        reason: "which resolves to a local or private network address that safety blocks by default",
        hint  : "Ask the owner to set safety.allowPrivateNetworks to true, or to list the host in safety.allowedDomains.",
    },
    private: {
        reason: "which is a local or private network address that safety blocks by default",
        hint  : "Ask the owner to set safety.allowPrivateNetworks to true, or to list the host in safety.allowedDomains.",
    },
};

export function describeBlock(block: Block): { reason: string; hint: string } {
    return REASONS[block];
}
