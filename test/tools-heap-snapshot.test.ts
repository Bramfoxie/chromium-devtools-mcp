import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { type ArtifactStore, heapSnapshot, runTool, ToolRuntime } from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const SNAPSHOT = JSON.stringify({
    snapshot: {
        meta: {
            node_fields: ["type", "name", "id", "self_size", "edge_count", "detachedness"],
            node_types : [["hidden", "object", "string"]],
        },
    },
    nodes  : [1, 0, 1, 40, 0, 0, 2, 1, 2, 60, 0, 0],
    strings: ["Thing", "SECRET-VALUE"],
});

function setup(options: { chunks?: string[]; failSnapshot?: boolean } = {}) {
    const fake = new FakeAccess({
        tabs: [{ targetId: "tab1", url: "https://a.example/", title: "t", owned: true, created: true }],
    });
    const written: Array<{ kind: string; extension: string; data: string }> = [];
    const artifacts: ArtifactStore = {
        write: async (kind, extension, data) => {
            written.push({ kind, extension, data: String(data) });

            return { path: `/data/artifacts/${kind}.${extension}`, bytes: String(data).length };
        },
    };

    fake.respond = (_tab, method) => {
        if (method === "HeapProfiler.takeHeapSnapshot") {
            for (const chunk of options.chunks ?? [SNAPSHOT.slice(0, 50), SNAPSHOT.slice(50)]) {
                fake.emit("cdp.event", {
                    targetId: "tab1",
                    event   : "HeapProfiler.addHeapSnapshotChunk",
                    params  : { chunk },
                });
            }

            fake.emit("cdp.event", {
                targetId: "tab2",
                event   : "HeapProfiler.addHeapSnapshotChunk",
                params  : { chunk: "FROM-ANOTHER-TAB" },
            });
        }

        return {};
    };

    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig, artifacts });

    runtime.attach();
    runtime.tabs.select("tab1");

    return { fake, runtime, written };
}

const methods = (fake: FakeAccess) => fake.sent.map((call) => call.method);

const text = (result: { content: unknown }) => JSON.stringify(result.content);

describe("heap_snapshot", () => {
    it("collects garbage, takes the snapshot, saves it and reports the summary", async () => {
        const { fake, runtime, written } = setup();
        const result = await runTool(heapSnapshot, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(methods(fake)).toEqual([
            "Page.enable",
            "HeapProfiler.collectGarbage",
            "HeapProfiler.takeHeapSnapshot",
        ]);
        expect(result.structuredContent).toMatchObject({
            tab       : "tab1",
            file      : { path: "/data/artifacts/heap-snapshot.heapsnapshot" },
            totalBytes: 100,
            nodeCount : 2,
        });
        expect(written).toEqual([
            { kind: "heap-snapshot", extension: "heapsnapshot", data: SNAPSHOT },
        ]);
        expect(JSON.stringify(result.structuredContent)).not.toContain("SECRET-VALUE");
        expect(JSON.stringify(result.structuredContent)).not.toContain("FROM-ANOTHER-TAB");
    });

    it("skips the garbage collection and the file when asked", async () => {
        const { fake, runtime, written } = setup();
        const result = await runTool(
            heapSnapshot,
            { collectGarbage: false, save: false },
            extra(),
            runtime,
        );

        expect(methods(fake)).not.toContain("HeapProfiler.collectGarbage");
        expect(result.structuredContent).not.toHaveProperty("file");
        expect(written).toEqual([]);
    });

    it("listens for the chunks only while it takes the snapshot", async () => {
        const { fake, runtime } = setup();

        await runTool(heapSnapshot, {}, extra(), runtime);

        expect(
            fake.subscribed.filter((entry) => entry.event === "HeapProfiler.addHeapSnapshotChunk"),
        ).toHaveLength(1);
        expect(
            fake.unsubscribed.filter((entry) => entry.event === "HeapProfiler.addHeapSnapshotChunk"),
        ).toHaveLength(1);
    });

    it("stops listening when the snapshot fails", async () => {
        const { fake, runtime } = setup();

        fake.failSend = (_tab, method) =>
            method === "HeapProfiler.takeHeapSnapshot" ? new Error("page crashed") : undefined;

        const result = await runTool(heapSnapshot, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(
            fake.unsubscribed.map((entry) => entry.event),
        ).toContain("HeapProfiler.addHeapSnapshotChunk");
    });

    it("refuses text that is not a snapshot", async () => {
        const { runtime, written } = setup({ chunks: ["not json"] });
        const result = await runTool(heapSnapshot, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("could not be read");
        expect(written).toEqual([]);
    });

    it("refuses JSON in a format it does not know", async () => {
        const { runtime } = setup({ chunks: ["{\"nodes\":[]}"] });
        const result = await runTool(heapSnapshot, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("format this server does not know");
    });

    it("drops a snapshot that is too large", async () => {
        const huge = "x".repeat(1024 * 1024);
        const { runtime, written } = setup({ chunks: Array.from({ length: 151 }, () => huge) });
        const result = await runTool(heapSnapshot, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("larger than 150 MiB");
        expect(written).toEqual([]);
    });

    it("counts as a dangerous call only when it saves the file", () => {
        const dangerous = heapSnapshot.dangerous as (args: { save?: boolean }) => boolean;

        expect(dangerous({})).toBe(true);
        expect(dangerous({ save: true })).toBe(true);
        expect(dangerous({ save: false })).toBe(false);
        expect(heapSnapshot.summarize?.({})).toContain("secrets");
    });

    it("is a reading tool that works in read-only mode", async () => {
        const { runtime } = setup();
        const readOnly = new ToolRuntime({
            access: runtime.access,
            config: { ...managedConfig, safety: { ...managedConfig.safety, readOnly: true } },
        });

        readOnly.attach();
        readOnly.tabs.select("tab1");

        const result = await runTool(heapSnapshot, { save: false }, extra(), readOnly);

        expect(result.isError).not.toBe(true);
    });
});
