import { type Block, type DomainPolicy, hostBlock } from "../../safety/index.js";

export type PatternVerdict =
    | { ok: true }
    | { ok: false; reason: "unparsable" }
    | { ok: false; reason: "host"; host: string; block: Block };

const SCHEME = /^(https?|\*):\/\/([^/]*)/i;

const HOST_WILDCARD = /[*?]/;

function unescaped(text: string): string {
    return text.replace(/\\(.)/g, "$1");
}

function deniedBeneath(base: string, denied: readonly string[]): string | undefined {
    return denied
        .map((rule) => rule.trim().toLowerCase().replace(/^\*\./, "").replace(/:\d{1,5}$/, "").replace(/\.$/, ""))
        .find((host) => host === base || host.endsWith(`.${base}`));
}

// A pattern is judged by the host it names, so it must name one: a wildcard in the host is allowed
// only as a leading "*." in front of a literal host that the rules accept.
export function checkMockPattern(pattern: string, policy: DomainPolicy): PatternVerdict {
    const match = SCHEME.exec(pattern);

    if (match === null) return { ok: false, reason: "unparsable" };

    const authority = unescaped(match[2] ?? "").toLowerCase();
    const host = authority.replace(/:(\d{1,5}|\*)$/, "");
    const base = host.startsWith("*.") ? host.slice(2) : host;

    if (base === "" || HOST_WILDCARD.test(base) || host.includes("@")) {
        return { ok: false, reason: "unparsable" };
    }

    if (host.startsWith("*.") && deniedBeneath(base, policy.deniedDomains) !== undefined) {
        return { ok: false, reason: "host", host: base, block: "denied" };
    }

    const block = hostBlock(host.startsWith("*.") ? `sub.${base}` : base, policy);

    return block === undefined ? { ok: true } : { ok: false, reason: "host", host: base, block };
}
