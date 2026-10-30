import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { ProtocolViolationError } from "./errors.js";

export const MAX_LINE_BYTES = 1024 * 1024;

export const ErrorCode = {
  badRequest     : "bad_request",
  unknownMethod  : "unknown_method",
  internal       : "internal",
  busy           : "busy",
  sessionRequired: "session_required",
  sessionClosed  : "session_closed",
  notFound       : "not_found",
  notOwned       : "not_owned",
  alreadyClaimed : "already_claimed",
  forbiddenMethod: "forbidden_method",
  unsupportedUrl : "unsupported_url",
  notCreated     : "not_created",
  cdpError       : "cdp_error",
  cdpTimeout     : "cdp_timeout",
  browserClosed  : "browser_closed",
  resultTooLarge : "result_too_large",
  browserNotReady: "browser_not_ready",
} as const;

const id = z.number().int().nonnegative();

export const requestSchema = z.strictObject({
  id,
  method: z.string().min(1).max(100),
  params: z.unknown().optional(),
});

export const responseSchema = z.union([
  z.strictObject({ id, result: z.unknown().optional() }),
  z.strictObject({
    id,
    error: z.strictObject({ code: z.string().min(1), message: z.string() }),
  }),
]);

export const eventSchema = z.strictObject({
  event : z.string().min(1).max(100),
  params: z.unknown().optional(),
});

export const helloParamsSchema = z.strictObject({
  token     : z.string().min(1).max(256),
  clientName: z.string().min(1).max(64),
});

export const serverMessageSchema = z.union([responseSchema, eventSchema]);

export type Request = z.infer<typeof requestSchema>;
export type Response = z.infer<typeof responseSchema>;
export type ServerEvent = z.infer<typeof eventSchema>;
export type HelloParams = z.infer<typeof helloParamsSchema>;

export function encodeMessage(message: unknown): string {
  const line = JSON.stringify(message);

  if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
    throw new ProtocolViolationError(`a message exceeds ${MAX_LINE_BYTES} bytes`);
  }

  return `${line}\n`;
}

export function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new ProtocolViolationError("a line is not valid JSON");
  }
}

export class LineDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private pendingBytes = 0;

  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    let start = 0;

    for (;;) {
      const end = text.indexOf("\n", start);
      const segment = text.slice(start, end === -1 ? text.length : end);
      const bytes = this.pendingBytes + Buffer.byteLength(segment);

      if (bytes > MAX_LINE_BYTES) {
        throw new ProtocolViolationError(`a line exceeds ${MAX_LINE_BYTES} bytes`);
      }

      if (end === -1) {
        this.pending += segment;
        this.pendingBytes = bytes;

        return lines;
      }

      const line = this.pending + segment;

      this.pending = "";
      this.pendingBytes = 0;
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;

      if (trimmed.length > 0) lines.push(trimmed);

      start = end + 1;
    }
  }
}
