import { describe, expect, it } from "vitest";
import {
    binaryResult,
    errorResult,
    imageBlock,
    jsonResult,
    resourceBlock,
    textBlock,
    truncateText,
} from "../src/tools/index.js";

describe("truncateText", () => {
    it("keeps short text untouched", () => {
        expect(truncateText("hello", 10)).toEqual({ text: "hello", truncated: false, totalLength: 5 });
    });

    it("keeps text of exactly the limit untouched", () => {
        expect(truncateText("hello", 5)).toEqual({ text: "hello", truncated: false, totalLength: 5 });
    });

    it("marks text one over the limit with the totals", () => {
        expect(truncateText("hello!", 5)).toEqual({
            text       : "hello[truncated: 1 of 6 characters omitted]",
            truncated  : true,
            totalLength: 6,
        });
    });

    it("counts multi byte characters as one and never splits a surrogate pair", () => {
        const text = "ab\u{1F600}cd";

        expect(truncateText(text, 3)).toEqual({
            text       : "ab\u{1F600}[truncated: 2 of 5 characters omitted]",
            truncated  : true,
            totalLength: 5,
        });
    });

    it("handles empty text", () => {
        expect(truncateText("", 5)).toEqual({ text: "", truncated: false, totalLength: 0 });
    });

    it("handles a zero limit", () => {
        expect(truncateText("ab", 0)).toEqual({
            text       : "[truncated: 2 of 2 characters omitted]",
            truncated  : true,
            totalLength: 2,
        });
    });
});

describe("result builders", () => {
    it("builds a JSON result with matching text and structured content", () => {
        const result = jsonResult({ answer: 42 });

        expect(result).toEqual({
            content          : [textBlock(JSON.stringify({ answer: 42 }))],
            structuredContent: { answer: 42 },
        });
    });

    it("builds binary results with the JSON first and the payload second", () => {
        const image = imageBlock({ data: "aGVsbG8=", mimeType: "image/png" });
        const result = binaryResult({ width: 3 }, image);

        expect(result.structuredContent).toEqual({ width: 3 });
        expect(result.content).toEqual([textBlock(JSON.stringify({ width: 3 })), image]);
        expect(image).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
    });

    it("builds resource blocks with a blob", () => {
        expect(resourceBlock("pdf://report", { data: "aGVsbG8=", mimeType: "application/pdf" })).toEqual({
            type    : "resource",
            resource: { uri: "pdf://report", mimeType: "application/pdf", blob: "aGVsbG8=" },
        });
    });

    it("builds an error result", () => {
        expect(errorResult("Something failed. Try again.")).toEqual({
            content: [textBlock("Something failed. Try again.")],
            isError: true,
        });
    });
});
