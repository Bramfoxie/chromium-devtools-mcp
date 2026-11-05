import type { NetworkRecord } from "./network-log.js";

export interface HarHeader {
    name : string;
    value: string;
}

export interface HarEntry {
    startedDateTime: string;
    time           : number;
    request        : Record<string, unknown>;
    response       : Record<string, unknown>;
    cache          : Record<string, never>;
    timings        : { send: number; wait: number; receive: number };
    _resourceType  : string;
    _fromCache?    : true;
    _failed?       : string;
}

export interface Har {
    log: {
        version: "1.2";
        creator: { name: string; version: string };
        entries: HarEntry[];
    };
}

function headersOf(headers: Record<string, string> | undefined): HarHeader[] {
    return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));
}

function queryOf(url: string): HarHeader[] {
    try {
        return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
    } catch {
        return [];
    }
}

function redirectOf(record: NetworkRecord): string {
    const found = Object.entries(record.responseHeaders ?? {})
        .find(([name]) => name.toLowerCase() === "location");

    return found?.[1] ?? "";
}

// Records carry redacted URLs and headers and no bodies, so the file holds neither secrets nor content.
export function buildHar(
    records: readonly NetworkRecord[],
    creator: { name: string; version: string },
    now    : () => number = () => Date.now(),
): Har {
    const known = records.find((record) => record.wallTime !== undefined)?.wallTime;
    const fallback = known === undefined ? now() : known * 1000;

    return {
        log: {
            version: "1.2",
            creator,
            entries: records.map((record) => {
                const started = record.wallTime === undefined ? fallback : record.wallTime * 1000;
                const duration = record.durationMs ?? 0;
                const size = record.encodedBytes;

                return {
                    startedDateTime: new Date(started).toISOString(),
                    time           : duration,
                    request        : {
                        method     : record.method,
                        url        : record.url,
                        httpVersion: "unknown",
                        cookies    : [],
                        headers    : headersOf(record.requestHeaders),
                        queryString: queryOf(record.url),
                        headersSize: -1,
                        bodySize   : -1,
                    },
                    response: {
                        status     : record.status ?? 0,
                        statusText : record.statusText ?? "",
                        httpVersion: "unknown",
                        cookies    : [],
                        headers    : headersOf(record.responseHeaders),
                        content    : { size: size ?? 0, mimeType: record.mimeType ?? "" },
                        redirectURL: redirectOf(record),
                        headersSize: -1,
                        bodySize   : size ?? -1,
                    },
                    cache        : {},
                    timings      : { send: 0, wait: duration, receive: 0 },
                    _resourceType: record.resourceType,
                    ...(record.fromCache ? { _fromCache: true as const } : {}),
                    ...(record.failed ? { _failed: record.errorText ?? "failed" } : {}),
                };
            }),
        },
    };
}
