import { z } from "zod";
import { redactHeaders, redactUrl } from "./redact.js";
import { testUrlPattern, type UrlPattern } from "./url-pattern.js";

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
    wallTime?       : number;
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

interface NetworkReduction {
    record    : NetworkRecord;
    created   : boolean;
    redirected: boolean;
}

type NetworkLookup = (requestId: string) => NetworkRecord | undefined;

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
        record.wallTime = data.wallTime;
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
    urlPattern?   : UrlPattern;
    methods?      : string[];
    resourceTypes?: string[];
    statusMin?    : number;
    statusMax?    : number;
    failedOnly?   : boolean;
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
