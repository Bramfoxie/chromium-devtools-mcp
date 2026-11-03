const WEB_PROTOCOLS = new Set(["http:", "https:"]);
const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };
const PATTERN = /^(\*\.)?(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/;

interface Rule {
    host     : string;
    subdomain: boolean;
    port?    : string;
}

function parseRule(pattern: string): Rule | undefined {
    const match = PATTERN.exec(pattern.trim().toLowerCase());

    if (match === null) return undefined;

    const host = (match[2] ?? "").replace(/\.$/, "");

    if (host === "") return undefined;

    return {
        host,
        subdomain: match[1] !== undefined,
        ...(match[3] === undefined ? {} : { port: String(Number(match[3])) }),
    };
}

function matches(rule: Rule, host: string, port: string | undefined): boolean {
    if (rule.port !== undefined && rule.port !== port) return false;

    return rule.subdomain ? host.endsWith(`.${rule.host}`) : host === rule.host;
}

export function isRestricted(patterns: readonly string[]): boolean {
    return patterns.length > 0;
}

export function isHostAllowed(
    host    : string,
    patterns: readonly string[],
    port?   : string,
): boolean {
    if (!isRestricted(patterns)) return true;

    const normalized = host.toLowerCase().replace(/\.$/, "");

    return patterns.some((pattern) => {
        const rule = parseRule(pattern);

        return rule !== undefined && matches(rule, normalized, port);
    });
}

export function hostOfUrl(url: string): string | undefined {
    try {
        const parsed = new URL(url);

        return WEB_PROTOCOLS.has(parsed.protocol) ? parsed.hostname : undefined;
    } catch {
        return undefined;
    }
}

export function isUrlAllowed(url: string, patterns: readonly string[]): boolean {
    if (!isRestricted(patterns)) return true;

    if (url.toLowerCase() === "about:blank") return true;

    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        return false;
    }

    if (!WEB_PROTOCOLS.has(parsed.protocol)) return false;

    const port = parsed.port === "" ? DEFAULT_PORTS[parsed.protocol] : parsed.port;

    return isHostAllowed(parsed.hostname, patterns, port);
}

export function describeUrlHost(url: string): string {
    try {
        const parsed = new URL(url);

        if (WEB_PROTOCOLS.has(parsed.protocol)) return parsed.host;

        return `a ${parsed.protocol.replace(/:$/, "")} page`;
    } catch {
        return "an unknown page";
    }
}
