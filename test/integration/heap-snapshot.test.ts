import { readFile, stat } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

const SECRET = "SUPER-SECRET-TOKEN-4f9a8c2e-1111";

const PAGE = `<!doctype html><title>Heap</title><body><div id="a">page</div><script>
class LeakyThing { constructor(i) { this.i = i; this.label = "item-" + i; } }
window.keep = Array.from({ length: 20000 }, (_, i) => new LeakyThing(i));
window.token = ${JSON.stringify(SECRET)} + "-" + Math.random();
window.password = ["hunter2", ${JSON.stringify(SECRET)}.toUpperCase()].join("-");
window.detached = [document.createElement("span"), document.createElement("div"), document.createElement("div")];
</script></body>`;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/heap", { body: PAGE, status: 200, type: "text/html" });
});

afterAll(async () => {
    await env?.stop();
});

type Snapshot = {
    tab       : string;
    file?     : { path: string; bytes: number };
    totalBytes: number;
    nodeCount : number;
    byType    : Array<{ type: string; count: number; bytes: number }>;
    classes   : Array<{ name: string; type: string; count: number; bytes: number }>;
    detached  : { count: number; tags: Array<{ tag: string; count: number }> };
    insights  : Array<{ id: string }>;
};

describe.skipIf(!present)("heap_snapshot in a real browser", () => {
    it("reports the classes and detached nodes and never the contents of strings", async () => {
        const tab = await env.open("/heap");
        const result = (await env.ok("heap_snapshot", { tab })) as unknown as Snapshot;

        const leaky = result.classes.find((entry) => entry.name === "LeakyThing");

        expect(leaky).toMatchObject({ type: "object", count: 20000 });
        expect(result.totalBytes).toBeGreaterThan(1_000_000);
        expect(result.nodeCount).toBeGreaterThan(100_000);
        expect(result.byType.some((entry) => entry.type === "string")).toBe(true);
        expect(result.classes.some((entry) => entry.name === "(string)")).toBe(true);
        expect(result.detached.count).toBeGreaterThanOrEqual(3);
        expect(result.detached.tags).toEqual(
            expect.arrayContaining([
                { tag: "div", count: 2 },
                { tag: "span", count: 1 },
            ]),
        );
        expect(result.insights.map((insight) => insight.id)).toContain("detached-dom");

        const json = JSON.stringify(result);

        for (const secret of [SECRET, SECRET.toUpperCase(), "hunter2", "item-100"]) {
            expect(json).not.toContain(secret);
        }

        expect(json).not.toContain("127.0.0.1");
    });

    it("saves the snapshot for the Memory panel when asked, and only then", async () => {
        const tab = await env.open("/heap");
        const saved = (await env.ok("heap_snapshot", { tab, topClasses: 3 })) as unknown as Snapshot;
        const bare = (await env.ok("heap_snapshot", { tab, save: false })) as unknown as Snapshot;

        expect(saved.classes).toHaveLength(3);
        expect(saved.file?.path.startsWith(env.artifactsDir)).toBe(true);
        expect(saved.file?.path.endsWith(".heapsnapshot")).toBe(true);
        expect((await stat(saved.file?.path ?? "")).size).toBe(saved.file?.bytes);

        const file = JSON.parse(await readFile(saved.file?.path ?? "", "utf8")) as { nodes: number[] };

        expect(file.nodes.length).toBeGreaterThan(0);
        expect(bare.file).toBeUndefined();
    });

    it("works on a tab that is in the background and after a garbage collection is skipped", async () => {
        const tab = await env.open("/heap");
        const result = (await env.ok("heap_snapshot", { tab, collectGarbage: false, save: false })) as unknown as Snapshot;

        expect(result.nodeCount).toBeGreaterThan(0);
    });
});
