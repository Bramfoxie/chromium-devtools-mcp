import { describe, expect, it } from "vitest";
import { traceFile } from "../src/tools/perf/trace-file.js";
import type { TraceEvent } from "../src/tools/perf/trace-filter.js";

const parse = (events: TraceEvent[]) =>
    JSON.parse(Buffer.from(traceFile(events)).toString("utf8")) as {
        traceEvents: TraceEvent[];
        metadata   : { source: string };
    };

describe("traceFile", () => {
    it("writes an empty trace as valid JSON", () => {
        expect(parse([])).toEqual({
            traceEvents: [],
            metadata   : { source: "chromium-devtools-mcp" },
        });
    });

    it("keeps every event in order across the pieces it is built from", () => {
        const events: TraceEvent[] = Array.from({ length: 12_345 }, (_, index) => ({
            ph  : "X",
            ts  : index,
            name: `event-${index}`,
        }));
        const parsed = parse(events);

        expect(parsed.traceEvents).toHaveLength(12_345);
        expect(parsed.traceEvents[0]?.name).toBe("event-0");
        expect(parsed.traceEvents[5000]?.name).toBe("event-5000");
        expect(parsed.traceEvents.at(-1)?.name).toBe("event-12344");
    });
});
