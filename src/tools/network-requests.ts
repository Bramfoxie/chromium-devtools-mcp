import { z } from "zod";
import { type NetworkFilter, type UrlPattern, compileUrlPattern } from "./capture/network-log.js";
import { defineTool } from "./define-tool.js";
import { ToolError } from "./errors.js";

export const NETWORK_REQUESTS_DEFAULT_LIMIT = 50;

export const NETWORK_REQUESTS_MAX_LIMIT = 300;

export const NETWORK_URL_CONTAINS_MAX_CHARS = 1024;

export const NETWORK_URL_REGEX_MAX_CHARS = 200;

export const NETWORK_LIST_MAX_ITEMS = 50;

export const NETWORK_LIST_ITEM_MAX_CHARS = 64;

const networkEntrySchema = z.strictObject({
    id             : z.number().describe("Monotonic record id for afterId paging and network_response_body."),
    requestId      : z.string().describe("Browser request id shared by the records of one redirect chain."),
    method         : z.string().describe("HTTP method."),
    url            : z.string().describe("URL with sensitive query values replaced by [redacted]."),
    resourceType   : z.string().describe("CDP resource type such as Document, XHR or WebSocket."),
    status         : z.number().optional().describe("HTTP status of the response, when observed."),
    statusText     : z.string().optional().describe("HTTP status text, when observed."),
    mimeType       : z.string().optional().describe("Response MIME type, when observed."),
    fromCache      : z.boolean().describe("Whether the response was served from the cache."),
    failed         : z.boolean().describe("Whether the request failed."),
    finished       : z.boolean().describe("Whether the request finished or failed."),
    errorText      : z.string().optional().describe("Failure reason, when the request failed."),
    durationMs     : z.number().optional().describe("Request duration in milliseconds, when known."),
    encodedBytes   : z.number().optional().describe("Encoded response size in bytes, when known."),
    initiator      : z.string().optional().describe("CDP initiator type, when known."),
    redirectedFrom : z.number().optional().describe("Id of the previous record in a redirect chain."),
    requestHeaders : z.record(z.string(), z.string()).optional().describe("Redacted request headers, only with includeHeaders."),
    responseHeaders: z.record(z.string(), z.string()).optional().describe("Redacted response headers, only with includeHeaders."),
});

const listOf = (label: string) =>
    z
        .array(z.string().min(1).max(NETWORK_LIST_ITEM_MAX_CHARS))
        .max(NETWORK_LIST_MAX_ITEMS)
        .optional()
        .describe(label);

export function networkFilterOf(args: {
    urlContains?  : string | undefined;
    urlRegex?     : string | undefined;
    methods?      : string[] | undefined;
    resourceTypes?: string[] | undefined;
    statusMin?    : number | undefined;
    statusMax?    : number | undefined;
    failedOnly?   : boolean | undefined;
}): NetworkFilter {
    let urlPattern: UrlPattern | undefined;

    if (args.urlRegex !== undefined) {
        try {
            urlPattern = compileUrlPattern(args.urlRegex);
        } catch (error) {
            throw new ToolError(
                error instanceof Error ? error.message : "The pattern is not a valid regular expression.",
            );
        }
    }

    return {
        urlContains  : args.urlContains,
        urlPattern,
        methods      : args.methods,
        resourceTypes: args.resourceTypes,
        statusMin    : args.statusMin,
        statusMax    : args.statusMax,
        failedOnly   : args.failedOnly,
    };
}

export const networkRequests = defineTool({
    name: "network_requests",
    description:
        "Read HTTP requests of a tab since network capture started. Sensitive query values and header values are replaced by [redacted].",
    access: "read",
    input : z.strictObject({
        tab           : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        urlContains   : z.string().min(1).max(NETWORK_URL_CONTAINS_MAX_CHARS).optional().describe("Keep only URLs containing this text."),
        urlRegex      : z.string().min(1).max(NETWORK_URL_REGEX_MAX_CHARS).optional().describe("Keep only URLs matching this regular expression, up to 200 characters. A match that takes longer than 50 ms is stopped and fails the call."),
        methods       : listOf("Keep only these HTTP methods."),
        resourceTypes : listOf("Keep only these CDP resource types."),
        statusMin     : z.number().int().min(100).max(599).optional().describe("Keep only responses with at least this status."),
        statusMax     : z.number().int().min(100).max(599).optional().describe("Keep only responses with at most this status."),
        failedOnly    : z.boolean().optional().describe("Keep only failed requests."),
        afterId       : z.number().int().min(0).optional().describe("Return records after this id for paging."),
        limit         : z.number().int().min(1).max(NETWORK_REQUESTS_MAX_LIMIT).optional().describe("Maximum records to return. Defaults to 50."),
        includeHeaders: z.boolean().optional().describe("Include redacted request and response headers. Defaults to false."),
        clear         : z.boolean().optional().describe("Empty the buffer after reading. Defaults to false."),
    }),
    output: z.strictObject({
        tab          : z.string().describe("Tab id."),
        requests     : z.array(networkEntrySchema).describe("Buffered network records."),
        nextAfterId  : z.number().describe("Pass as afterId to continue paging."),
        droppedCount : z.number().describe("Records evicted from the buffer since the last read."),
        returned     : z.number().describe("Number of returned records."),
        totalBuffered: z.number().describe("Records currently buffered for the tab."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        const filter = networkFilterOf(args);

        await context.capture.ensureNetwork(targetId);

        const includeHeaders = args.includeHeaders ?? false;
        const read = context.capture.readNetwork(targetId, {
            filter,
            afterId: args.afterId,
            limit  : args.limit ?? NETWORK_REQUESTS_DEFAULT_LIMIT,
            clear  : args.clear ?? false,
        });

        return {
            tab     : targetId,
            requests: read.records.map(({ id, record }) => ({
                id,
                requestId   : record.requestId,
                method      : record.method,
                url         : record.url,
                resourceType: record.resourceType,
                ...(record.status === undefined ? {} : { status: record.status }),
                ...(record.statusText === undefined ? {} : { statusText: record.statusText }),
                ...(record.mimeType === undefined ? {} : { mimeType: record.mimeType }),
                fromCache   : record.fromCache,
                failed      : record.failed,
                finished    : record.finished,
                ...(record.errorText === undefined ? {} : { errorText: record.errorText }),
                ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
                ...(record.encodedBytes === undefined ? {} : { encodedBytes: record.encodedBytes }),
                ...(record.initiator === undefined ? {} : { initiator: record.initiator }),
                ...(record.redirectedFrom === undefined
                    ? {}
                    : { redirectedFrom: record.redirectedFrom }),
                ...(includeHeaders && record.requestHeaders !== undefined
                    ? { requestHeaders: record.requestHeaders }
                    : {}),
                ...(includeHeaders && record.responseHeaders !== undefined
                    ? { responseHeaders: record.responseHeaders }
                    : {}),
            })),
            nextAfterId  : read.nextAfterId,
            droppedCount : read.droppedCount,
            returned     : read.records.length,
            totalBuffered: read.totalBuffered,
        };
    },
});
