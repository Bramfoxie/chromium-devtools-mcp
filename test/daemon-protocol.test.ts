import { describe, expect, it } from "vitest";
import { MAX_RESPONSE_BYTES } from "../src/daemon/index.js";
import { encodeMessage, LineDecoder, MAX_REQUEST_BYTES } from "../src/daemon/protocol.js";
import { ProtocolViolationError } from "../src/daemon/errors.js";
import {
    boundedFailureMessage,
    DaemonEvent,
    eventSchema,
    failureParamsSchema,
    helloParamsSchema,
    requestSchema,
    serverMessageSchema,
} from "../src/daemon/protocol.js";

describe("encodeMessage", () => {
    it("writes one JSON line", () => {
        expect(encodeMessage({ id: 1, method: "ping" })).toBe('{"id":1,"method":"ping"}\n');
    });

    it("uses a 1 MiB request limit and a 32 MiB response limit", () => {
        expect(MAX_REQUEST_BYTES).toBe(1048576);
        expect(MAX_RESPONSE_BYTES).toBe(33554432);
    });

    it("caps requests at 1 MiB", () => {
        const overhead = Buffer.byteLength(JSON.stringify({ s: "" }));
        const fits = { s: "x".repeat(MAX_REQUEST_BYTES - overhead) };

        expect(encodeMessage(fits, MAX_REQUEST_BYTES).length).toBe(MAX_REQUEST_BYTES + 1);
        expect(() =>
            encodeMessage({ s: "x".repeat(MAX_REQUEST_BYTES - overhead + 1) }, MAX_REQUEST_BYTES),
        ).toThrow(ProtocolViolationError);
    });

    it("accepts a response above 1 MiB and rejects one above 32 MiB", () => {
        const overhead = Buffer.byteLength(JSON.stringify({ s: "" }));
        const large = { s: "x".repeat(MAX_REQUEST_BYTES + 100) };

        expect(encodeMessage(large).length).toBe(MAX_REQUEST_BYTES + overhead + 101);
        const fits = { s: "x".repeat(MAX_RESPONSE_BYTES - overhead) };

        expect(encodeMessage(fits).length).toBe(MAX_RESPONSE_BYTES + 1);
        expect(() => encodeMessage({ s: "x".repeat(MAX_RESPONSE_BYTES - overhead + 1) })).toThrow(
            ProtocolViolationError,
        );
    });
});

describe("LineDecoder", () => {
    it("enforces the limit it was built with on both boundaries", () => {
        expect(new LineDecoder(MAX_REQUEST_BYTES).push(`${"x".repeat(1048576)}\n`)).toHaveLength(1);
        expect(() => new LineDecoder(MAX_REQUEST_BYTES).push(`${"x".repeat(1048577)}\n`)).toThrow(
            ProtocolViolationError,
        );
        expect(new LineDecoder(MAX_RESPONSE_BYTES).push(`${"x".repeat(1048577)}\n`)).toHaveLength(1);
    });

    it("handles a long unterminated line sent in tiny chunks in linear time", { timeout: 10_000 }, () => {
        const decoder = new LineDecoder(MAX_REQUEST_BYTES);

        for (let i = 0; i < 100_000; i += 1) decoder.push("x");
        expect(decoder.push("\n")).toHaveLength(1);
    });

    it("handles many short lines in one chunk in linear time", { timeout: 10_000 }, () => {
        const lines = new LineDecoder(MAX_REQUEST_BYTES).push("a\n".repeat(200_000));

        expect(lines).toHaveLength(200_000);
    });

    it("decodes a 31 MiB line in linear time", { timeout: 30_000 }, () => {
        const decoder = new LineDecoder(MAX_RESPONSE_BYTES);
        const line = "x".repeat(31 * 1024 * 1024);

        expect(decoder.push(`${line}\n`)).toEqual([line]);
    });

    it("keeps the byte count across chunks for a line that finally completes", () => {
        const decoder = new LineDecoder(MAX_REQUEST_BYTES);

        decoder.push("x".repeat(1048576 - 1));
        expect(() => decoder.push("yy\n")).toThrow(ProtocolViolationError);
    });

    it("returns complete lines and keeps the rest", () => {
        const decoder = new LineDecoder(MAX_REQUEST_BYTES);

        expect(decoder.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
        expect(decoder.push(":2}\n")).toEqual(['{"b":2}']);
    });

    it("returns several lines from one chunk", () => {
        expect(new LineDecoder(MAX_REQUEST_BYTES).push("one\ntwo\nthree\n")).toEqual([
            "one",
            "two",
            "three",
        ]);
    });

    it("accepts CRLF and skips empty lines", () => {
        expect(new LineDecoder(MAX_REQUEST_BYTES).push("one\r\n\r\n\ntwo\n")).toEqual([
            "one",
            "two",
        ]);
    });

    it("does not split a multibyte character across chunks", () => {
        const bytes = Buffer.from("\u044f\u044f\n");
        const decoder = new LineDecoder(MAX_REQUEST_BYTES);

        expect(decoder.push(bytes.subarray(0, 1))).toEqual([]);
        expect(decoder.push(bytes.subarray(1, 3))).toEqual([]);
        expect(decoder.push(bytes.subarray(3))).toEqual(["\u044f\u044f"]);
    });

    it("accepts a line at the limit", () => {
        const line = "x".repeat(MAX_REQUEST_BYTES);

        expect(new LineDecoder(MAX_REQUEST_BYTES).push(`${line}\n`)).toEqual([line]);
    });

    it("rejects a complete line above the limit", () => {
        expect(() =>
            new LineDecoder(MAX_REQUEST_BYTES).push(`${"x".repeat(MAX_REQUEST_BYTES + 1)}\n`),
        ).toThrow(ProtocolViolationError);
    });

    it("rejects an unterminated line that grows above the limit", () => {
        const decoder = new LineDecoder(MAX_REQUEST_BYTES);

        expect(decoder.push("x".repeat(MAX_REQUEST_BYTES))).toEqual([]);
        expect(() => decoder.push("x")).toThrow(ProtocolViolationError);
    });

    it("measures the limit in bytes", () => {
        const wide = "\u044f".repeat(MAX_REQUEST_BYTES / 2 + 1);

        expect(() => new LineDecoder(MAX_REQUEST_BYTES).push(`${wide}\n`)).toThrow(
            ProtocolViolationError,
        );
    });
});

describe("schemas", () => {
    it("accepts a request with and without params", () => {
        expect(requestSchema.safeParse({ id: 0, method: "m" }).success).toBe(true);
        expect(requestSchema.safeParse({ id: 3, method: "m", params: { a: 1 } }).success).toBe(true);
    });

    it.each([
        ["negative id", { id: -1, method: "m" }],
        ["fractional id", { id: 1.5, method: "m" }],
        ["string id", { id: "1", method: "m" }],
        ["empty method", { id: 1, method: "" }],
        ["long method", { id: 1, method: "m".repeat(101) }],
        ["extra field", { id: 1, method: "m", extra: true }],
        ["no method", { id: 1 }],
    ])("rejects a request with %s", (_name, value) => {
        expect(requestSchema.safeParse(value).success).toBe(false);
    });

    it("accepts responses and events from the server", () => {
        expect(serverMessageSchema.safeParse({ id: 1, result: 5 }).success).toBe(true);
        expect(serverMessageSchema.safeParse({ id: 1 }).success).toBe(true);
        expect(
            serverMessageSchema.safeParse({ id: 1, error: { code: "x", message: "m" } }).success,
        ).toBe(true);
        expect(serverMessageSchema.safeParse({ event: "e", params: [1] }).success).toBe(true);
    });

    it.each([
        ["error without code", { id: 1, error: { message: "m" } }],
        ["result and error together", { id: 1, result: 1, error: { code: "x", message: "m" } }],
        ["event and id together", { id: 1, event: "e" }],
        ["empty event", { event: "" }],
    ])("rejects a server message with %s", (_name, value) => {
        expect(serverMessageSchema.safeParse(value).success).toBe(false);
        if (!("id" in value)) expect(eventSchema.safeParse(value).success).toBe(false);
    });

    it("validates hello params", () => {
        expect(helloParamsSchema.safeParse({ token: "t", clientName: "c" }).success).toBe(true);
        expect(helloParamsSchema.safeParse({ token: "", clientName: "c" }).success).toBe(false);
        expect(helloParamsSchema.safeParse({ token: "t", clientName: "" }).success).toBe(false);
        expect(helloParamsSchema.safeParse({ token: "t", clientName: "c".repeat(65) }).success).toBe(
            false,
        );
        expect(helloParamsSchema.safeParse({ token: "t", clientName: "c", extra: 1 }).success).toBe(
            false,
        );
    });
});

describe("failure messages", () => {
    it("names the failure event and accepts its params", () => {
        expect(DaemonEvent.failed).toBe("daemon.failed");
        expect(failureParamsSchema.safeParse({ message: "x" }).success).toBe(true);
        expect(failureParamsSchema.safeParse({ message: "x", extra: 1 }).success).toBe(false);
        expect(eventSchema.safeParse({ event: DaemonEvent.failed, params: { message: "x" } }).success).toBe(true);
    });

    it("collapses whitespace into a single line", () => {
        expect(boundedFailureMessage("a\n  b\r\n\tc")).toBe("a b c");
    });

    it("cuts long messages to 500 characters", () => {
        const cut = boundedFailureMessage("x".repeat(900));

        expect(cut).toHaveLength(500);
        expect(cut.endsWith("...")).toBe(true);
        expect(boundedFailureMessage("y".repeat(500))).toBe("y".repeat(500));
    });
});
