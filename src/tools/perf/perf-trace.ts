import { z } from "zod";
import { defineTool } from "../define-tool.js";
import { ensureNoDialog } from "../dialogs.js";
import { ToolError } from "../errors.js";
import { pageNavigate } from "../page-navigate.js";
import { throwIfCancelled } from "../registry.js";
import { resolveTab, tabSchema } from "../tab-target.js";
import { filterTrace } from "./trace-filter.js";
import { summarizeTrace } from "./trace-summary.js";

const insightSchema = z.strictObject({
    id    : z.string().describe("Short name of the finding."),
    level : z.enum(["good", "warn", "poor"]).describe("How the measured value rates."),
    title : z.string().describe("The finding with its measured value."),
    detail: z.string().describe("The thresholds and what is behind the value."),
});

export const perfTraceStart = defineTool({
    name       : "perf_trace_start",
    closedWorld: true,
    description:
        "Start recording a performance trace of a tab. Optionally reload the page so the whole load is recorded. Interact with the page, then call perf_trace_stop. Only one trace can record at a time in the browser.",
    access: (args: unknown) =>
        (args as { reload?: unknown } | null)?.reload === true ? "mutate" : "read",
    input: z.strictObject({
        tab        : tabSchema,
        reload     : z.boolean().optional().describe("Reload the page once the trace has started, so the load is recorded. Defaults to false."),
        ignoreCache: z.boolean().optional().describe("With reload: ignore the cache. Defaults to false."),
    }),
    output: z.strictObject({
        tab      : z.string().describe("Tab id."),
        recording: z.boolean().describe("Whether the trace is recording."),
        reloaded : z.boolean().describe("Whether the page was reloaded after the start."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        throwIfCancelled(context.signal);
        await ensureNoDialog(context.dialogs, targetId);
        await context.focus.ensure(context.access, targetId);
        await context.trace.start(targetId);

        if (args.reload !== true) return { tab: targetId, recording: true, reloaded: false };

        try {
            await pageNavigate.handler(
                { tab: targetId, action: "reload", ignoreCache: args.ignoreCache ?? false },
                context,
            );
        } catch (error) {
            await context.trace.forget(targetId);

            throw error;
        }

        return { tab: targetId, recording: true, reloaded: true };
    },
});

export const perfTraceStop = defineTool({
    name       : "perf_trace_stop",
    closedWorld: true,
    description:
        "Stop the trace of a tab, save it as a file that the Performance panel of Chrome DevTools opens, and report the Core Web Vitals, long tasks, main thread activity, requests and a rating of each. The file and the numbers hold the tab only, never the other tabs of the browser.",
    access: "read",
    input : z.strictObject({ tab: tabSchema }),
    output: z.strictObject({
        tab : z.string().describe("Tab id."),
        file: z.strictObject({
            path : z.string().describe("Absolute path of the saved trace on the machine of the server."),
            bytes: z.number().describe("Size of the file in bytes."),
        }).describe("The trace of this tab in the Chrome trace format."),
        events: z.strictObject({
            kept     : z.number().describe("Trace events of the tab that are in the file."),
            dropped  : z.number().describe("Events of the browser and of other tabs that were left out."),
            truncated: z.boolean().describe("Whether recording stopped early because the trace was too large."),
        }),
        durationMs: z.number().describe("Length of the recorded span in milliseconds."),
        vitals    : z.strictObject({
            fcpMs: z.number().optional().describe("First Contentful Paint, from the last navigation."),
            lcpMs: z.number().optional().describe("Largest Contentful Paint, from the last navigation."),
            lcp  : z.strictObject({
                element: z.string().optional().describe("The largest element."),
                type   : z.string().optional().describe("text or image."),
                size   : z.number().optional().describe("Area of the element in square pixels."),
            }).optional(),
            cls         : z.number().describe("Cumulative Layout Shift of the worst session window."),
            shifts      : z.number().describe("Layout shifts without recent input."),
            inpMs       : z.number().optional().describe("Interaction to Next Paint, present when the trace holds interactions."),
            interactions: z.number().describe("Interactions in the trace."),
            tbtMs       : z.number().describe("Total Blocking Time: time of long tasks over 50 ms after the first paint."),
        }),
        mainThreadMs: z.strictObject({
            scripting: z.number(),
            rendering: z.number(),
            painting : z.number(),
            loading  : z.number(),
            gc       : z.number(),
            other    : z.number(),
        }).describe("Self time of the main thread by activity, in milliseconds."),
        longTasks: z.array(z.strictObject({
            startMs   : z.number().describe("Start relative to the last navigation."),
            durationMs: z.number().describe("Length of the task."),
        })).describe("The longest tasks over 50 ms, at most 5."),
        network: z.strictObject({
            requests     : z.number(),
            failed       : z.number(),
            transferBytes: z.number(),
            largest      : z.array(z.strictObject({
                url  : z.string().describe("Address with secrets redacted."),
                type : z.string(),
                bytes: z.number(),
            })),
        }),
        insights: z.array(insightSchema).describe("Each measured value rated against the Web Vitals thresholds."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        throwIfCancelled(context.signal);

        const recorded = await context.trace.stop(targetId);
        const frames = await context.access.listFrames(targetId);
        const mainFrame = frames.find((frame) => frame.parentFrameId === undefined)?.frameId;

        if (mainFrame === undefined) {
            throw new ToolError("The frames of the tab could not be read, so the trace was dropped. Record it again.");
        }

        const tabFrames = new Set(frames.map((frame) => frame.frameId));
        const filtered = filterTrace(recorded.events, tabFrames);
        const summary = summarizeTrace(filtered.events, mainFrame);
        const file = await context.artifacts.write(
            "perf-trace",
            "json",
            JSON.stringify({ traceEvents: filtered.events, metadata: { source: "chromium-devtools-mcp" } }),
        );

        return {
            tab   : targetId,
            file,
            events: {
                kept     : filtered.events.length,
                dropped  : filtered.dropped,
                truncated: recorded.truncated,
            },
            durationMs  : summary.durationMs,
            vitals      : summary.vitals,
            mainThreadMs: summary.mainThreadMs,
            longTasks   : summary.longTasks,
            network     : summary.network,
            insights    : summary.insights,
        };
    },
});
