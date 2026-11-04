import type { TraceEvent } from "./trace-filter.js";

const EVENTS_PER_PIECE = 5000;

// Builds the file piece by piece, so a large trace never needs one string.
export function traceFile(events: readonly TraceEvent[]): Uint8Array {
    const pieces: Buffer[] = [Buffer.from('{"traceEvents":[')];

    for (let start = 0; start < events.length; start += EVENTS_PER_PIECE) {
        const slice = events.slice(start, start + EVENTS_PER_PIECE);
        const text = slice.map((event) => JSON.stringify(event)).join(",");

        pieces.push(Buffer.from(start === 0 ? text : `,${text}`));
    }

    pieces.push(Buffer.from('],"metadata":{"source":"chromium-devtools-mcp"}}'));

    return Buffer.concat(pieces);
}
