import type {
    CallToolResult,
    EmbeddedResource,
    ImageContent,
    TextContent,
} from "@modelcontextprotocol/sdk/types.js";

export interface TruncatedText {
    text       : string;
    truncated  : boolean;
    totalLength: number;
}

export function truncateText(text: string, limit: number): TruncatedText {
    const totalLength = [...text].length;

    if (totalLength <= limit) return { text, truncated: false, totalLength };

    const omitted = totalLength - limit;
    const kept = [...text].slice(0, limit).join("");

    return {
        text     : `${kept}[truncated: ${omitted} of ${totalLength} characters omitted]`,
        truncated: true,
        totalLength,
    };
}

export interface BinaryContent {
    data    : string;
    mimeType: string;
}

export function textBlock(text: string): TextContent {
    return { type: "text", text };
}

export function imageBlock(image: BinaryContent): ImageContent {
    return { type: "image", data: image.data, mimeType: image.mimeType };
}

export function resourceBlock(uri: string, blob: BinaryContent): EmbeddedResource {
    return {
        type    : "resource",
        resource: { uri, mimeType: blob.mimeType, blob: blob.data },
    };
}

export function jsonResult(value: Record<string, unknown>): CallToolResult {
    return { content: [textBlock(JSON.stringify(value))], structuredContent: value };
}

export function binaryResult(
    value: Record<string, unknown>,
    extra: ImageContent | EmbeddedResource,
): CallToolResult {
    return { content: [textBlock(JSON.stringify(value)), extra], structuredContent: value };
}

export function errorResult(message: string): CallToolResult {
    return { content: [textBlock(message)], isError: true };
}
