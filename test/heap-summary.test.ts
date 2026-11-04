import { describe, expect, it } from "vitest";
import { summarizeHeap } from "../src/tools/perf/heap-summary.js";

const TYPES = ["hidden", "array", "string", "object", "code", "closure", "number", "native"];
const FIELDS = ["type", "name", "id", "self_size", "edge_count", "detachedness"];

interface Node {
    type     : string;
    name     : string;
    size     : number;
    detached?: number;
}

function snapshot(nodes: Node[]): unknown {
    const strings: string[] = [];
    const index = (text: string): number => {
        const known = strings.indexOf(text);

        if (known >= 0) return known;

        strings.push(text);

        return strings.length - 1;
    };
    const flat: number[] = [];

    nodes.forEach((node, at) => {
        flat.push(
            TYPES.indexOf(node.type),
            index(node.name),
            at + 1,
            node.size,
            0,
            node.detached ?? 0,
        );
    });

    return {
        snapshot: { meta: { node_fields: FIELDS, node_types: [TYPES] } },
        nodes   : flat,
        strings,
    };
}

describe("summarizeHeap", () => {
    const summary = summarizeHeap(
        snapshot([
            { type: "object", name: "Leaky", size: 30 },
            { type: "object", name: "Leaky", size: 30 },
            { type: "object", name: "Other", size: 5 },
            { type: "string", name: "SUPER-SECRET-TOKEN", size: 100 },
            { type: "string", name: "hunter2", size: 50 },
            { type: "number", name: "3.14159", size: 8 },
            { type: "closure", name: "render", size: 12 },
            { type: "code", name: "(render) https://a.example/app.js?token=abc:10", size: 40 },
            { type: "native", name: "Window / http://127.0.0.1:9222", size: 20 },
            { type: "native", name: "<div>", size: 10, detached: 2 },
            { type: "native", name: "<div id='x'>", size: 10, detached: 2 },
            { type: "native", name: "<span>", size: 10, detached: 2 },
            { type: "native", name: "Detached node", size: 10, detached: 2 },
            { type: "native", name: "<p>", size: 10, detached: 1 },
        ]),
        20,
    );

    it("sums the sizes and counts the objects", () => {
        expect(summary?.totalBytes).toBe(30 + 30 + 5 + 100 + 50 + 8 + 12 + 40 + 20 + 10 * 5);
        expect(summary?.nodeCount).toBe(14);
        expect(summary?.byType[0]).toEqual({ type: "string", count: 2, bytes: 150 });
    });

    it("groups objects by name, strings and numbers by type only", () => {
        const names = summary?.classes.map((entry) => entry.name) ?? [];

        expect(names).toContain("Leaky");
        expect(names).toContain("(string)");
        expect(names).toContain("(number)");
        expect(summary?.classes.find((entry) => entry.name === "Leaky")).toEqual({
            name : "Leaky",
            type : "object",
            count: 2,
            bytes: 60,
        });
        expect(summary?.classes.find((entry) => entry.name === "(string)")).toMatchObject({
            count: 2,
            bytes: 150,
        });
    });

    it("keeps no string content and no address in the result", () => {
        const json = JSON.stringify(summary);

        for (const leak of ["SUPER-SECRET", "hunter2", "3.14159", "127.0.0.1", "a.example", "token=abc"]) {
            expect(json).not.toContain(leak);
        }

        expect(summary?.classes.map((entry) => entry.name)).toEqual(
            expect.arrayContaining(["Window", "(render)"]),
        );
    });

    it("counts the detached nodes by tag and warns about them", () => {
        expect(summary?.detached.count).toBe(4);
        expect(summary?.detached.tags).toEqual([
            { tag: "div", count: 2 },
            { tag: "span", count: 1 },
            { tag: "(other)", count: 1 },
        ]);
        expect(summary?.insights.map((insight) => insight.id)).toContain("detached-dom");
    });

    it("lists the biggest classes first and cuts the list to the asked length", () => {
        const short = summarizeHeap(
            snapshot([
                { type: "object", name: "A", size: 1 },
                { type: "object", name: "B", size: 3 },
                { type: "object", name: "C", size: 2 },
            ]),
            2,
        );

        expect(short?.classes.map((entry) => entry.name)).toEqual(["B", "C"]);
        expect(short?.detached).toEqual({ count: 0, tags: [] });
        expect(short?.insights).toEqual([]);
    });

    it("warns when strings take most of a large heap", () => {
        const big = summarizeHeap(
            snapshot([
                { type: "string", name: "x", size: 30 * 1024 * 1024 },
                { type: "object", name: "A", size: 1024 },
            ]),
            5,
        );

        expect(big?.insights.map((insight) => insight.id)).toEqual(["string-heavy"]);
    });

    it("names an empty class as unnamed and cuts a long name", () => {
        const odd = summarizeHeap(
            snapshot([
                { type: "object", name: "", size: 1 },
                { type: "object", name: "N".repeat(300), size: 2 },
            ]),
            5,
        );

        expect(odd?.classes.map((entry) => entry.name)).toEqual(["N".repeat(80), "(unnamed)"]);
    });

    it.each([
        [null],
        [{}],
        [{ snapshot: { meta: { node_fields: [], node_types: [[]] } }, nodes: [], strings: [] }],
        [{ snapshot: { meta: { node_fields: ["type"], node_types: [[]] } }, nodes: [], strings: [] }],
    ])("gives up on a snapshot it does not understand", (value) => {
        expect(summarizeHeap(value, 5)).toBeUndefined();
    });
});
