import { describe, expect, it } from "vitest";
import {
  encodeMessage,
  LineDecoder,
  MAX_LINE_BYTES,
  ProtocolViolationError,
} from "../src/daemon/index.js";
import {
  eventSchema,
  helloParamsSchema,
  requestSchema,
  serverMessageSchema,
} from "../src/daemon/protocol.js";

describe("encodeMessage", () => {
  it("writes one JSON line", () => {
    expect(encodeMessage({ id: 1, method: "ping" })).toBe('{"id":1,"method":"ping"}\n');
  });

  it("accepts a message at the size limit and rejects one above it", () => {
    const overhead = Buffer.byteLength(JSON.stringify({ s: "" }));
    const fits = { s: "x".repeat(MAX_LINE_BYTES - overhead) };

    expect(encodeMessage(fits).length).toBe(MAX_LINE_BYTES + 1);
    expect(() => encodeMessage({ s: "x".repeat(MAX_LINE_BYTES - overhead + 1) })).toThrow(
      ProtocolViolationError,
    );
  });
});

describe("LineDecoder", () => {
  it("uses a one mebibyte limit", () => {
    expect(MAX_LINE_BYTES).toBe(1048576);
  });

  it("accepts exactly 1048576 bytes and rejects one more", () => {
    expect(new LineDecoder().push(`${"x".repeat(1048576)}\n`)).toHaveLength(1);
    expect(() => new LineDecoder().push(`${"x".repeat(1048577)}\n`)).toThrow(
      ProtocolViolationError,
    );
  });

  it("handles a long unterminated line sent in tiny chunks in linear time", () => {
    const decoder = new LineDecoder();
    const started = Date.now();

    for (let i = 0; i < 100_000; i += 1) decoder.push("x");
    expect(decoder.push("\n")).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("handles many short lines in one chunk in linear time", () => {
    const started = Date.now();
    const lines = new LineDecoder().push("a\n".repeat(200_000));

    expect(lines).toHaveLength(200_000);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("keeps the byte count across chunks for a line that finally completes", () => {
    const decoder = new LineDecoder();

    decoder.push("x".repeat(1048576 - 1));
    expect(() => decoder.push("yy\n")).toThrow(ProtocolViolationError);
  });

  it("returns complete lines and keeps the rest", () => {
    const decoder = new LineDecoder();

    expect(decoder.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(decoder.push(":2}\n")).toEqual(['{"b":2}']);
  });

  it("returns several lines from one chunk", () => {
    expect(new LineDecoder().push("one\ntwo\nthree\n")).toEqual(["one", "two", "three"]);
  });

  it("accepts CRLF and skips empty lines", () => {
    expect(new LineDecoder().push("one\r\n\r\n\ntwo\n")).toEqual(["one", "two"]);
  });

  it("does not split a multibyte character across chunks", () => {
    const bytes = Buffer.from("\u044f\u044f\n");
    const decoder = new LineDecoder();

    expect(decoder.push(bytes.subarray(0, 1))).toEqual([]);
    expect(decoder.push(bytes.subarray(1, 3))).toEqual([]);
    expect(decoder.push(bytes.subarray(3))).toEqual(["\u044f\u044f"]);
  });

  it("accepts a line at the limit", () => {
    const line = "x".repeat(MAX_LINE_BYTES);

    expect(new LineDecoder().push(`${line}\n`)).toEqual([line]);
  });

  it("rejects a complete line above the limit", () => {
    expect(() => new LineDecoder().push(`${"x".repeat(MAX_LINE_BYTES + 1)}\n`)).toThrow(
      ProtocolViolationError,
    );
  });

  it("rejects an unterminated line that grows above the limit", () => {
    const decoder = new LineDecoder();

    expect(decoder.push("x".repeat(MAX_LINE_BYTES))).toEqual([]);
    expect(() => decoder.push("x")).toThrow(ProtocolViolationError);
  });

  it("measures the limit in bytes", () => {
    const wide = "\u044f".repeat(MAX_LINE_BYTES / 2 + 1);

    expect(() => new LineDecoder().push(`${wide}\n`)).toThrow(ProtocolViolationError);
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
