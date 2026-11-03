import { z } from "zod";
import {
    ErrorCode,
    MAX_RESPONSE_BYTES,
    RESULT_TOO_LARGE_MESSAGE,
    RpcError,
} from "../daemon/index.js";
import { defineTool } from "./define-tool.js";
import { ToolError } from "./errors.js";
import { truncateText } from "./result.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const RESPONSE_BODY_DEFAULT_CHARS = 50_000;

const RESPONSE_BODY_MAX_CHARS = 500_000;

const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "image/svg"];

const TEXT_MIME_SUFFIXES = ["+json", "+xml"];

const bodySchema = z.object({ body: z.string(), base64Encoded: z.boolean() });

export function isTextMimeType(mimeType: string | undefined): boolean {
    if (mimeType === undefined) return false;

    const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";

    return TEXT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix)) ||
        TEXT_MIME_SUFFIXES.some((suffix) => mime.endsWith(suffix)) ||
        mime === "application/javascript";
}

export function bodyByteSize(body: string, base64Encoded: boolean): number {
    return base64Encoded ? Buffer.byteLength(body, "base64") : Buffer.byteLength(body);
}

export const networkResponseBody = defineTool({
    name: "network_response_body",
    description:
        "Read the response body of a request from network_requests. Binary bodies need asBase64.",
    access: "read",
    input : z.strictObject({
        tab      : tabSchema,
        requestId: z.number().int().min(1).describe("Record id from network_requests."),
        maxChars : z.number().int().min(1).max(RESPONSE_BODY_MAX_CHARS).optional().describe("Maximum characters of the returned body. Defaults to 50000."),
        asBase64 : z.boolean().optional().describe("Return binary content as base64. Defaults to false."),
    }),
    output: z.strictObject({
        tab        : z.string().describe("Tab id."),
        requestId  : z.number().describe("Record id from network_requests."),
        mimeType   : z.string().optional().describe("Response MIME type, when known."),
        size       : z.number().optional().describe("Body size in bytes, when known."),
        base64     : z.boolean().describe("Whether the body is base64 encoded."),
        body       : z.string().optional().describe("The body, truncated with a marker when it exceeds maxChars."),
        truncated  : z.boolean().optional().describe("Whether the body was truncated."),
        totalLength: z.number().optional().describe("Total body length in characters before truncation."),
        needsBase64: z.boolean().optional().describe("True when the body is binary and asBase64 was not set."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        await context.capture.ensureNetwork(targetId);

        const known = context.capture.networkRecord(targetId, args.requestId);

        if (known === undefined) {
            throw new ToolError(
                `No request with id ${args.requestId} is buffered for this tab. Capture starts with the first network_requests call, so earlier requests are missing. Call network_requests to see the buffered ids.`,
            );
        }

        if (known.record.redirect) {
            throw new ToolError(
                "Redirect responses have no body. Follow the chain to the next record id.",
            );
        }

        if (!known.record.finished && !known.record.failed) {
            throw new ToolError("The request is still loading. Call the tool again in a moment.");
        }

        let result: unknown;

        try {
            result = await context.access.send(targetId, "Network.getResponseBody", {
                requestId: known.record.requestId,
            });
        } catch (error) {
            if (error instanceof RpcError && error.code === ErrorCode.resultTooLarge) {
                throw new ToolError(RESULT_TOO_LARGE_MESSAGE);
            }

            if (error instanceof RpcError && error.code === ErrorCode.cdpError) {
                throw new ToolError(
                    "The browser no longer has the body of this request. It was evicted or the request failed before responding.",
                );
            }

            throw error;
        }

        const parsed = bodySchema.safeParse(result);

        if (!parsed.success) {
            throw new ToolError(
                "The browser sent an unexpected response to Network.getResponseBody. Try the call again.",
            );
        }

        const maxChars = args.maxChars ?? RESPONSE_BODY_DEFAULT_CHARS;
        const size = bodyByteSize(parsed.data.body, parsed.data.base64Encoded);

        if (size > MAX_RESPONSE_BYTES) {
            throw new ToolError(RESULT_TOO_LARGE_MESSAGE);
        }

        const mimeType = known.record.mimeType;

        const wantsText = (args.asBase64 ?? false) === false && !isTextMimeType(mimeType);

        if (parsed.data.base64Encoded && wantsText) {
            return {
                tab        : targetId,
                requestId  : args.requestId,
                ...(mimeType === undefined ? {} : { mimeType }),
                size,
                base64     : false as const,
                needsBase64: true as const,
            };
        }

        if (parsed.data.base64Encoded && !isTextMimeType(mimeType)) {
            const chars = Math.max(4, Math.floor(maxChars / 4) * 4);
            const totalLength = parsed.data.body.length;
            const truncated = totalLength > chars;
            const body = truncated ? parsed.data.body.slice(0, chars) : parsed.data.body;

            return {
                tab      : targetId,
                requestId: args.requestId,
                ...(mimeType === undefined ? {} : { mimeType }),
                size,
                base64   : true as const,
                body,
                ...(truncated ? { truncated: true as const, totalLength } : {}),
            };
        }

        const text = parsed.data.base64Encoded && isTextMimeType(mimeType)
            ? Buffer.from(parsed.data.body, "base64").toString("utf8")
            : parsed.data.body;
        const shaped = truncateText(text, maxChars);

        return {
            tab      : targetId,
            requestId: args.requestId,
            ...(mimeType === undefined ? {} : { mimeType }),
            size,
            base64   : false as const,
            ...(shaped.truncated
                ? { body: shaped.text, truncated: true, totalLength: shaped.totalLength }
                : { body: shaped.text }),
        };
    },
});
