import { z } from "zod";
import { parseEnvelope } from "../cdp-envelope.js";
import { defineTool, type ToolContext } from "../define-tool.js";
import { ensureNoDialog } from "../dialogs.js";
import { ToolError } from "../errors.js";
import { throwIfCancelled } from "../registry.js";
import { resolveTab, tabSchema } from "../tab-target.js";
import { summarizeHeap } from "./heap-summary.js";

const CHUNK_EVENT = "HeapProfiler.addHeapSnapshotChunk";

const SNAPSHOT_TIMEOUT_MS = 120_000;

const MAX_SNAPSHOT_CHARS = 150 * 1024 * 1024;

const TOP_DEFAULT = 15;

const TOP_MAX = 50;

const chunkSchema = z.object({ chunk: z.string() });

interface Collected {
    chunks  : string[];
    chars   : number;
    tooLarge: boolean;
}

async function collectSnapshot(context: ToolContext, targetId: string): Promise<Collected> {
    const collected: Collected = { chunks: [], chars: 0, tooLarge: false };
    const off = context.access.on("cdp.event", (params) => {
        const envelope = parseEnvelope(params);

        if (envelope?.targetId !== targetId || envelope.event !== CHUNK_EVENT) return;

        const chunk = chunkSchema.safeParse(envelope.params);

        if (!chunk.success || collected.tooLarge) return;

        collected.chars += chunk.data.chunk.length;

        if (collected.chars > MAX_SNAPSHOT_CHARS) {
            collected.tooLarge = true;
            collected.chunks.length = 0;

            return;
        }

        collected.chunks.push(chunk.data.chunk);
    });

    try {
        await context.access.subscribe(targetId, CHUNK_EVENT);
        await context.access.send({
            targetId,
            method   : "HeapProfiler.takeHeapSnapshot",
            params   : {},
            timeoutMs: SNAPSHOT_TIMEOUT_MS,
        });
    } finally {
        off();
        await context.access.unsubscribe(targetId, CHUNK_EVENT).catch(() => undefined);
    }

    return collected;
}

export const heapSnapshot = defineTool({
    name       : "heap_snapshot",
    closedWorld: true,
    description:
        "Take a heap snapshot of a tab and report what is in memory: the total, the size by kind of object, the biggest classes and the detached DOM nodes. The page freezes while the snapshot is taken. The snapshot file can be saved for you to open in the Memory panel of Chrome DevTools; the result never holds the contents of strings.",
    access   : "read",
    dangerous: (args: { save?: boolean | undefined }) => args.save !== false,
    summarize: () =>
        "It writes everything that is in the memory of the page, including secrets such as tokens and passwords, to a file on this machine.",
    input: z.strictObject({
        tab           : tabSchema,
        collectGarbage: z.boolean().optional().describe("Run a garbage collection first, so only live objects are counted. Defaults to true."),
        save          : z.boolean().optional().describe("Save the snapshot as a .heapsnapshot file for the Memory panel of Chrome DevTools. Defaults to true. The file holds all the page memory, including secrets, so pass false to get the summary only."),
        topClasses    : z.number().int().min(1).max(TOP_MAX).optional().describe(`How many classes to list, 1 to ${TOP_MAX}. Defaults to ${TOP_DEFAULT}.`),
    }),
    output: z.strictObject({
        tab : z.string().describe("Tab id."),
        file: z.strictObject({
            path : z.string().describe("Absolute path of the snapshot on the machine of the server."),
            bytes: z.number().describe("Size of the file in bytes."),
        }).optional().describe("The saved snapshot, present unless save is false."),
        totalBytes: z.number().describe("Self size of all objects in bytes."),
        nodeCount : z.number().describe("Objects in the snapshot."),
        byType    : z.array(z.strictObject({
            type : z.string().describe("Kind of heap object, for example object, string, array, code or native."),
            count: z.number(),
            bytes: z.number(),
        })).describe("Size by kind of object, the biggest first."),
        classes: z.array(z.strictObject({
            name : z.string().describe("Class or function name; strings, numbers and symbols are listed by type only."),
            type : z.string(),
            count: z.number(),
            bytes: z.number(),
        })).describe("The biggest groups by name and kind."),
        detached: z.strictObject({
            count: z.number().describe("DOM nodes that are out of the page but still referenced."),
            tags : z.array(z.strictObject({ tag: z.string(), count: z.number() })),
        }),
        insights: z.array(z.strictObject({
            id    : z.string(),
            level : z.enum(["warn", "poor"]),
            title : z.string(),
            detail: z.string(),
        })),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        throwIfCancelled(context.signal);
        await ensureNoDialog(context.dialogs, targetId);

        if (args.collectGarbage !== false) {
            await context.access.send({ targetId, method: "HeapProfiler.collectGarbage", params: {} });
        }

        const collected = await collectSnapshot(context, targetId);

        if (collected.tooLarge) {
            throw new ToolError(
                "The snapshot is larger than 150 MiB, so it was dropped. Close what the page keeps in memory and try again.",
            );
        }

        const text = collected.chunks.join("");
        let parsed: unknown;

        try {
            parsed = JSON.parse(text);
        } catch {
            throw new ToolError("The browser sent a heap snapshot that could not be read. Try again.");
        }

        const summary = summarizeHeap(parsed, args.topClasses ?? TOP_DEFAULT);

        if (summary === undefined) {
            throw new ToolError("The heap snapshot has a format this server does not know.");
        }

        const file = args.save === false
            ? undefined
            : await context.artifacts.write("heap-snapshot", "heapsnapshot", text);

        return {
            tab       : targetId,
            ...(file === undefined ? {} : { file }),
            totalBytes: summary.totalBytes,
            nodeCount : summary.nodeCount,
            byType    : summary.byType,
            classes   : summary.classes,
            detached  : summary.detached,
            insights  : summary.insights,
        };
    },
});
