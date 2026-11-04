import type { Writable } from "node:stream";
import { messageOf } from "./message-of.js";
import { writeLogLine } from "./stderr.js";

const MAX_LOGGED_CHARS = 200;

export function logDaemon(message: string): void {
    writeLogLine(message);
}

export function quoted(text: string): string {
    const clipped = text.length > MAX_LOGGED_CHARS ? `${text.slice(0, MAX_LOGGED_CHARS)}...` : text;

    return JSON.stringify(clipped);
}

export function describeError(error: unknown): string {
    return quoted(messageOf(error));
}

export function ignoreStreamErrors(stream: Pick<Writable, "on"> = process.stderr): void {
    stream.on("error", () => undefined);
}
