import { z } from "zod";

export const REDACTED = "[redacted]";

export const NETWORK_REGEX_MAX_CHARS = 200;

export const NETWORK_URL_MATCH_CHARS = 2048;

const SENSITIVE_QUERY_PARTS = ["token", "key", "secret", "password", "auth", "session", "sig", "code"];

const SENSITIVE_HEADERS = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
]);

const URL_BEARING_HEADERS = new Set(["referer", "location", "origin", "content-location"]);

const SENSITIVE_HEADER_PARTS = [
    "token",
    "secret",
    "auth",
    "key",
    "session",
    "password",
    "code",
    "sig",
];

export interface NetworkRecord {
    requestId       : string;
    method          : string;
    url             : string;
    resourceType    : string;
    status?         : number;
    statusText?     : string;
    mimeType?       : string;
    fromCache       : boolean;
    failed          : boolean;
    finished        : boolean;
    redirect        : boolean;
    errorText?      : string;
    startTime?      : number;
    finishedAt?     : number;
    durationMs?     : number;
    encodedBytes?   : number;
    initiator?      : string;
    redirectedFrom? : number;
    requestHeaders? : Record<string, string>;
    responseHeaders?: Record<string, string>;
}

const headersSchema = z.record(z.string(), z.unknown());

const requestSchema = z.object({
    url    : z.string(),
    method : z.string(),
    headers: headersSchema.optional(),
});

const responseSchema = z.object({
    url          : z.string(),
    status       : z.number(),
    statusText   : z.string(),
    headers      : headersSchema.optional(),
    mimeType     : z.string().optional(),
    fromDiskCache: z.boolean().optional(),
});

const requestWillBeSent = z.object({
    requestId       : z.string(),
    loaderId        : z.string().optional(),
    documentURL     : z.string().optional(),
    request         : requestSchema,
    timestamp       : z.number(),
    wallTime        : z.number().optional(),
    initiator       : z.object({ type: z.string() }).passthrough().optional(),
    redirectResponse: responseSchema.optional(),
    type            : z.string().optional(),
});

const responseReceived = z.object({
    requestId: z.string(),
    loaderId : z.string().optional(),
    timestamp: z.number(),
    type     : z.string().optional(),
    response : responseSchema,
});

const loadingFinished = z.object({
    requestId        : z.string(),
    timestamp        : z.number(),
    encodedDataLength: z.number(),
});

const loadingFailed = z.object({
    requestId: z.string(),
    timestamp: z.number(),
    type     : z.string().optional(),
    errorText: z.string(),
    canceled : z.boolean().optional(),
});

const requestServedFromCache = z.object({ requestId: z.string() });

const webSocketCreated = z.object({
    requestId: z.string(),
    url      : z.string(),
    initiator: z.object({ type: z.string() }).passthrough().optional(),
});

function sensitiveName(name: string, parts: string[]): boolean {
    const lower = name.toLowerCase();

    return parts.some((part) => lower.includes(part));
}

function decodeName(name: string): string {
    try {
        return decodeURIComponent(name);
    } catch {
        return name;
    }
}

function redactParams(raw: string): string {
    return raw.split("&").map((pair) => {
        const cut = pair.indexOf("=");
        const name = cut === -1 ? pair : pair.slice(0, cut);

        if (!sensitiveName(decodeName(name), SENSITIVE_QUERY_PARTS)) return pair;

        return `${name}=${REDACTED}`;
    }).join("&");
}

export function redactUrl(url: string): string {
    // Userinfo never reaches the model: credentials in the URL are replaced.
    const withoutUserinfo = url.replace(/^(https?:\/\/)[^@/]*@/, `$1${REDACTED}@`);
    const query = withoutUserinfo.indexOf("?");

    if (query === -1) {
        const hashOnly = withoutUserinfo.indexOf("#");

        if (hashOnly === -1) return withoutUserinfo;

        return `${withoutUserinfo.slice(0, hashOnly + 1)}${redactParams(withoutUserinfo.slice(hashOnly + 1))}`;
    }

    const head = withoutUserinfo.slice(0, query + 1);
    const hash = withoutUserinfo.indexOf("#", query);
    const tail = hash === -1
        ? ""
        : `#${redactParams(withoutUserinfo.slice(hash + 1))}`;
    const raw = withoutUserinfo.slice(query + 1, hash === -1 ? withoutUserinfo.length : hash);

    return `${head}${redactParams(raw)}${tail}`;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
    const redacted: Record<string, string> = {};

    for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase();

        const sensitive = SENSITIVE_HEADERS.has(lower) ||
            sensitiveName(lower, SENSITIVE_HEADER_PARTS);

        if (sensitive) {
            redacted[name] = REDACTED;

            continue;
        }

        redacted[name] = URL_BEARING_HEADERS.has(lower) ? redactUrl(value) : value;
    }

    return redacted;
}

function stringHeaders(value: unknown): Record<string, string> | undefined {
    const parsed = headersSchema.safeParse(value);

    if (!parsed.success) return undefined;

    const headers: Record<string, string> = {};

    for (const [name, raw] of Object.entries(parsed.data)) {
        headers[name] = typeof raw === "string" ? raw : JSON.stringify(raw) ?? "";
    }

    return redactHeaders(headers);
}

function emptyRecord(requestId: string): NetworkRecord {
    return { requestId, method: "", url: "", resourceType: "", fromCache: false, failed: false, finished: false, redirect: false };
}

function msBetween(start: number | undefined, end: number): number | undefined {
    if (start === undefined) return undefined;

    return Math.max(0, Math.round((end - start) * 1000));
}

export interface NetworkReduction {
    record    : NetworkRecord;
    created   : boolean;
    redirected: boolean;
}

export type NetworkLookup = (requestId: string) => NetworkRecord | undefined;

export function reduceNetworkEvent(
    event : string,
    params: unknown,
    find  : NetworkLookup,
): NetworkReduction | undefined {
    if (event === "Network.requestWillBeSent") {
        const parsed = requestWillBeSent.safeParse(params);

        if (!parsed.success) return undefined;

        const data = parsed.data;
        const known = find(data.requestId);

        // The browser repeats the event without a redirect when a request restarts.
        if (data.redirectResponse === undefined && known !== undefined) {
            known.method = data.request.method;
            known.url = redactUrl(data.request.url);
            if (data.type !== undefined && data.type !== "") known.resourceType = data.type;
            if (data.initiator?.type !== undefined) known.initiator = data.initiator.type;

            const headers = stringHeaders(data.request.headers);

            if (headers !== undefined) known.requestHeaders = headers;

            return { record: known, created: false, redirected: false };
        }

        const previous = data.redirectResponse === undefined ? undefined : known;

        if (previous !== undefined && data.redirectResponse) {
            previous.status = data.redirectResponse.status;
            previous.statusText = data.redirectResponse.statusText;
            previous.mimeType = data.redirectResponse.mimeType;
            previous.redirect = true;
            previous.finished = true;
            previous.durationMs = msBetween(previous.startTime, data.timestamp);
        }

        const record = emptyRecord(data.requestId);

        record.method = data.request.method;
        record.url = redactUrl(data.request.url);
        record.resourceType = data.type ?? "";
        record.startTime = data.timestamp;
        record.initiator = data.initiator?.type;
        record.requestHeaders = stringHeaders(data.request.headers);

        return { record, created: true, redirected: previous !== undefined };
    }

    if (event === "Network.responseReceived") {
        const parsed = responseReceived.safeParse(params);

        if (!parsed.success) return undefined;

        const data = parsed.data;
        const record = find(data.requestId) ?? emptyRecord(data.requestId);
        const created = record.method === "" && record.url === "";

        if (record.url === "") record.url = redactUrl(data.response.url);

        record.status = data.response.status;
        record.statusText = data.response.statusText;
        record.mimeType = data.response.mimeType;

        if (data.type !== undefined && data.type !== "") record.resourceType = data.type;
        if (data.response.fromDiskCache === true) record.fromCache = true;

        record.responseHeaders = stringHeaders(data.response.headers);

        return { record, created, redirected: false };
    }

    if (event === "Network.loadingFinished") {
        const parsed = loadingFinished.safeParse(params);

        if (!parsed.success) return undefined;

        const data = parsed.data;
        const record = find(data.requestId) ?? emptyRecord(data.requestId);
        const created = record.method === "" && record.url === "";

        record.finished = true;
        record.durationMs = msBetween(record.startTime, data.timestamp);
        record.encodedBytes = data.encodedDataLength;

        return { record, created, redirected: false };
    }

    if (event === "Network.loadingFailed") {
        const parsed = loadingFailed.safeParse(params);

        if (!parsed.success) return undefined;

        const data = parsed.data;
        const record = find(data.requestId) ?? emptyRecord(data.requestId);
        const created = record.method === "" && record.url === "";

        record.finished = true;
        record.failed = true;
        record.errorText = data.errorText;
        record.durationMs = msBetween(record.startTime, data.timestamp);

        if (data.type !== undefined && data.type !== "") record.resourceType = data.type;

        return { record, created, redirected: false };
    }

    if (event === "Network.requestServedFromCache") {
        const parsed = requestServedFromCache.safeParse(params);

        if (!parsed.success) return undefined;

        const record = find(parsed.data.requestId);

        if (record === undefined) return undefined;

        record.fromCache = true;

        return { record, created: false, redirected: false };
    }

    if (event === "Network.webSocketCreated") {
        const parsed = webSocketCreated.safeParse(params);

        if (!parsed.success) return undefined;

        const data = parsed.data;
        const record = emptyRecord(data.requestId);

        record.method = "GET";
        record.url = redactUrl(data.url);
        record.resourceType = "WebSocket";
        record.initiator = data.initiator?.type;

        return { record, created: true, redirected: false };
    }

    return undefined;
}

export interface NetworkFilter {
    urlContains?  : string;
    urlPattern?   : RegExp;
    methods?      : string[];
    resourceTypes?: string[];
    statusMin?    : number;
    statusMax?    : number;
    failedOnly?   : boolean;
}

const NETWORK_REGEX_MAX_UNBOUNDED = 2;

const QUANTIFIER_BRACES = /^\{(\d+)(?:(,)(\d*))?\}/;

interface PatternGroup {
    quantified: boolean;
    alternated: boolean;
}

function unsafePattern(pattern: string): boolean {
    const stack: PatternGroup[] = [];
    let current: PatternGroup = { quantified: false, alternated: false };
    let lastGroup: PatternGroup | undefined;
    let unbounded = 0;
    let index = 0;

    while (index < pattern.length) {
        const char = pattern.charAt(index);
        let quantifier: { repeats: boolean; unbounded: boolean } | undefined;
        let length = 1;

        if (char === "\\") {
            if (/[1-9k]/.test(pattern.charAt(index + 1))) return true;

            length = 2;
            lastGroup = undefined;
        } else if (char === "[") {
            let end = index + 1;

            while (end < pattern.length && pattern.charAt(end) !== "]") {
                end += pattern.charAt(end) === "\\" ? 2 : 1;
            }

            length = end + 1 - index;
            lastGroup = undefined;
        } else if (char === "(") {
            if (pattern.startsWith("(?", index) && !pattern.startsWith("(?:", index)) return true;

            stack.push(current);
            current = { quantified: false, alternated: false };
            lastGroup = undefined;

            if (pattern.startsWith("(?:", index)) length = 3;
        } else if (char === ")") {
            const parent = stack.pop();

            if (parent === undefined) return true;

            const closed = current;

            current = parent;
            current.quantified ||= closed.quantified;
            current.alternated ||= closed.alternated;
            lastGroup = closed;
        } else if (char === "|") {
            current.alternated = true;
            lastGroup = undefined;
        } else if (char === "*" || char === "+") {
            quantifier = { repeats: true, unbounded: true };
        } else if (char === "?") {
            quantifier = { repeats: false, unbounded: false };
        } else if (char === "{") {
            const match = QUANTIFIER_BRACES.exec(pattern.slice(index));

            if (match !== null) {
                const open = match[2] !== undefined && match[3] === "";
                const max = open ? Infinity : Number(match[3] || match[1]);

                quantifier = { repeats: max > 1, unbounded: open };
                length = match[0].length;
            } else {
                lastGroup = undefined;
            }
        } else {
            lastGroup = undefined;
        }

        if (quantifier !== undefined) {
            if (quantifier.repeats && lastGroup !== undefined) {
                if (lastGroup.quantified || lastGroup.alternated) return true;
            }

            current.quantified = true;

            if (quantifier.unbounded) unbounded += 1;

            lastGroup = undefined;

            if (pattern.charAt(index + length) === "?") length += 1;
        }

        index += length;
    }

    return stack.length > 0 || unbounded > NETWORK_REGEX_MAX_UNBOUNDED;
}

export function compileUrlPattern(pattern: string): RegExp {
    if (pattern.length > NETWORK_REGEX_MAX_CHARS) {
        throw new Error(`The pattern is longer than ${NETWORK_REGEX_MAX_CHARS} characters.`);
    }

    let compiled: RegExp;

    try {
        compiled = new RegExp(pattern);
    } catch {
        throw new Error("The pattern is not a valid regular expression.");
    }

    if (unsafePattern(pattern)) {
        throw new Error(
            "The pattern could be slow on long URLs. Use at most 2 unbounded repeats (*, + or {n,}), no repeated groups that contain repeats or alternation, no backreferences and no lookarounds.",
        );
    }

    return compiled;
}

export function testUrlPattern(pattern: RegExp, url: string): boolean {
    pattern.lastIndex = 0;

    return pattern.test(url.slice(0, NETWORK_URL_MATCH_CHARS));
}

export function matchNetworkRecord(record: NetworkRecord, filter: NetworkFilter): boolean {
    if (filter.urlContains !== undefined && !record.url.includes(filter.urlContains)) return false;

    if (filter.urlPattern !== undefined && !testUrlPattern(filter.urlPattern, record.url)) {
        return false;
    }

    if (filter.methods !== undefined && !filter.methods.includes(record.method)) return false;

    if (filter.resourceTypes !== undefined && !filter.resourceTypes.includes(record.resourceType)) {
        return false;
    }

    if (filter.statusMin !== undefined && (record.status ?? -1) < filter.statusMin) return false;
    if (filter.statusMax !== undefined && (record.status ?? -1) > filter.statusMax) return false;
    if (filter.failedOnly === true && !record.failed) return false;

    return true;
}
