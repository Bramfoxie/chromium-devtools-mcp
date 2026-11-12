import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { findExpression, findInPage, newTab, runTool, ToolRuntime } from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const rect = { x: 10, y: 20, width: 30, height: 12 };

async function run(evaluate: unknown, args: Record<string, unknown>) {
    const fake = new FakeAccess({ evaluate: evaluate as never });
    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

    await runTool(newTab, {}, extra(), runtime);

    return runTool(findInPage, args, extra(), runtime);
}

describe("findExpression", () => {
    it("carries the query as data and the scroll index", () => {
        const expression = findExpression({
            query        : 'a"); fetch("/x"); ("',
            caseSensitive: true,
            maxMatches   : 3,
            scrollIndex  : 1,
        });

        expect(expression).toContain(JSON.stringify('a"); fetch("/x"); ("'));
        expect(expression).toContain(", true, 3, 1, ");
    });
});

describe("find_in_page", () => {
    it("numbers the matches, clips the context and marks a longer list", async () => {
        const result = await run(
            {
                result: {
                    type : "object",
                    value: {
                        total    : 7,
                        exhausted: false,
                        scrolled : true,
                        matches  : [
                            { context: "y".repeat(900), tag: "p", rect, inViewport: true },
                            { context: "second", tag: "li", rect, inViewport: false },
                        ],
                    },
                },
            },
            { text: "needle", maxMatches: 2, scroll: true },
        );

        expect(result.structuredContent).toMatchObject({
            text      : "needle",
            total     : 7,
            truncated : true,
            incomplete: false,
            scrolled  : true,
            matches   : [{ index: 0, tag: "p", inViewport: true }, { index: 1, tag: "li" }],
        });

        const shaped = result.structuredContent as { matches: Array<{ context: string }> };
        const matches = shaped.matches;

        expect(matches[0]?.context).toHaveLength(200);
    });

    it("reports an exhausted search and an answer in the wrong form", async () => {
        const exhausted = await run(
            { result: { type: "object", value: { total: 0, exhausted: true, scrolled: false, matches: [] } } },
            { text: "x" },
        );

        expect(exhausted.structuredContent).toMatchObject({
            total     : 0,
            incomplete: true,
            truncated : false,
        });

        const thrown = await run({ result: { type: "object" }, exceptionDetails: { text: "boom" } }, { text: "x" });

        expect(thrown.isError).toBe(true);
        expect(JSON.stringify(thrown.content)).toContain("did not answer the search");

        const odd = await run({ result: { type: "object", value: { total: "many" } } }, { text: "x" });

        expect(odd.isError).toBe(true);
        expect(JSON.stringify(odd.content)).toContain("unexpected form");
    });

    it("refuses empty text and a scroll index past the limit", async () => {
        const empty = await run({ result: { type: "object" } }, { text: "" });
        const far = await run({ result: { type: "object" } }, { text: "x", scroll: true, index: 99 });

        expect(empty.isError).toBe(true);
        expect(far.isError).toBe(true);
    });
});
