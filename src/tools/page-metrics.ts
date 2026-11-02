import { z } from "zod";
import { defineTool, type ToolContext } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { ToolError } from "./errors.js";

export const METRICS_TIMEOUT_MS = 5000;

const KEEP_ZERO = new Set([
    "Documents",
    "Frames",
    "Nodes",
    "LayoutCount",
    "RecalcStyleCount",
    "LayoutObjects",
    "JSEventListeners",
    "JSHeapUsedSize",
    "JSHeapTotalSize",
]);

const METRIC_NAMES: Record<string, string> = {
    Documents          : "documents",
    Frames             : "frames",
    Nodes              : "nodes",
    JSEventListeners   : "listeners",
    LayoutCount        : "layoutCount",
    RecalcStyleCount   : "recalcStyleCount",
    LayoutDuration     : "layoutDurationMs",
    RecalcStyleDuration: "recalcStyleDurationMs",
    ScriptDuration     : "scriptDurationMs",
    JSHeapUsedSize     : "jsHeapUsedBytes",
    JSHeapTotalSize    : "jsHeapTotalBytes",
};

const DURATION_METRICS = new Set(["layoutDurationMs", "recalcStyleDurationMs", "scriptDurationMs"]);

const metricsSchema = z.object({
    metrics: z.array(z.object({ name: z.string(), value: z.number() })),
});

const layoutSchema = z.object({
    layoutViewport: z.object({
        pageX       : z.number(),
        pageY       : z.number(),
        clientWidth : z.number(),
        clientHeight: z.number(),
    }),
    contentSize: z.object({ width: z.number(), height: z.number() }),
});

const navigationSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z
            .object({
                dnsMs             : z.number().nullable().optional(),
                connectMs         : z.number().nullable().optional(),
                responseMs        : z.number().nullable().optional(),
                domContentLoadedMs: z.number().nullable().optional(),
                loadMs            : z.number().nullable().optional(),
            })
            .nullable()
            .optional(),
    }),
});

export const NAVIGATION_TIMING_EXPRESSION = `(() => {
  const entry = performance.getEntriesByType("navigation")[0];
  if (!entry) return null;
  const duration = (from, to) => (Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from ? Math.round((to - from) * 10) / 10 : (to === from && from > 0 ? 0 : null));
  return {
    dnsMs: duration(entry.domainLookupStart, entry.domainLookupEnd),
    connectMs: duration(entry.connectStart, entry.connectEnd),
    responseMs: duration(entry.responseStart, entry.responseEnd),
    domContentLoadedMs: duration(entry.startTime, entry.domContentLoadedEventEnd),
    loadMs: duration(entry.startTime, entry.loadEventEnd),
  };
})()`;

export function shapePerformanceMetrics(
    metrics: Array<{ name: string; value: number }>,
): Record<string, number> {
    const shaped: Record<string, number> = {};

    for (const metric of metrics) {
        const key = METRIC_NAMES[metric.name];

        if (key === undefined) continue;
        if (metric.value === 0 && !KEEP_ZERO.has(metric.name)) continue;

        shaped[key] = DURATION_METRICS.has(key)
            ? Math.round(metric.value * 100000) / 100
            : Math.round(metric.value * 100) / 100;
    }

    return shaped;
}

const performanceSchema = z.strictObject({
    documents            : z.number().optional().describe("Number of documents."),
    frames               : z.number().optional().describe("Number of frames."),
    nodes                : z.number().optional().describe("Number of DOM nodes."),
    listeners            : z.number().optional().describe("Number of JS event listeners."),
    layoutCount          : z.number().optional().describe("Layout count."),
    recalcStyleCount     : z.number().optional().describe("Style recalculation count."),
    layoutDurationMs     : z.number().optional().describe("Layout duration in milliseconds."),
    recalcStyleDurationMs: z.number().optional().describe("Style recalculation duration in milliseconds."),
    scriptDurationMs     : z.number().optional().describe("Script duration in milliseconds."),
    jsHeapUsedBytes      : z.number().optional().describe("Used JS heap in bytes."),
    jsHeapTotalBytes     : z.number().optional().describe("Total JS heap in bytes."),
});

const layoutOutput = z.strictObject({
    viewport: z.strictObject({
        width : z.number().describe("Layout viewport width in CSS pixels."),
        height: z.number().describe("Layout viewport height in CSS pixels."),
    }),
    contentSize: z.strictObject({
        width : z.number().describe("Content width in CSS pixels."),
        height: z.number().describe("Content height in CSS pixels."),
    }),
    scroll: z.strictObject({
        x: z.number().describe("Horizontal scroll offset."),
        y: z.number().describe("Vertical scroll offset."),
    }),
});

const navigationOutput = z.strictObject({
    dnsMs             : z.number().optional().describe("DNS lookup in milliseconds."),
    connectMs         : z.number().optional().describe("Connection setup in milliseconds."),
    responseMs        : z.number().optional().describe("Response transfer in milliseconds."),
    domContentLoadedMs: z.number().optional().describe("Time to DOMContentLoaded in milliseconds."),
    loadMs            : z.number().optional().describe("Time to the load event in milliseconds."),
});

export const pageMetrics = defineTool({
    name       : "page_metrics",
    description: "Read performance counters, layout metrics and navigation timing of a tab.",
    access     : "read",
    input      : z.strictObject({
        tab: z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
    }),
    output: z.strictObject({
        tab        : z.string().describe("Tab id."),
        performance: performanceSchema.describe("Counters from the Performance domain."),
        layout     : layoutOutput.describe("Viewport, content size and scroll offsets."),
        navigation : navigationOutput.optional().describe("Navigation timing, when the page reports it."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        await ensureNoDialog(context.dialogs, targetId);

        await context.access.send(targetId, "Performance.enable", {});

        try {
            const metrics = metricsSchema.safeParse(
                await context.access.send(targetId, "Performance.getMetrics", {}),
            );

            if (!metrics.success) {
                throw new ToolError(
                    "The browser sent an unexpected response to Performance.getMetrics. Try the call again.",
                );
            }

            const layout = layoutSchema.safeParse(
                await context.access.send(targetId, "Page.getLayoutMetrics", {}),
            );

            if (!layout.success) {
                throw new ToolError(
                    "The browser sent an unexpected response to Page.getLayoutMetrics. Try the call again.",
                );
            }

            const navigation = await readNavigation(context, targetId);

            return {
                tab        : targetId,
                performance: shapePerformanceMetrics(metrics.data.metrics),
                layout     : {
                    viewport: {
                        width : Math.round(layout.data.layoutViewport.clientWidth),
                        height: Math.round(layout.data.layoutViewport.clientHeight),
                    },
                    contentSize: {
                        width : Math.round(layout.data.contentSize.width),
                        height: Math.round(layout.data.contentSize.height),
                    },
                    scroll: {
                        x: Math.round(layout.data.layoutViewport.pageX),
                        y: Math.round(layout.data.layoutViewport.pageY),
                    },
                },
                ...(navigation === undefined ? {} : { navigation }),
            };
        } finally {
            await context.access.send(targetId, "Performance.disable", {}).catch(() => undefined);
        }
    },
});

async function readNavigation(
    context : ToolContext,
    targetId: string,
): Promise<z.infer<typeof navigationOutput> | undefined> {
    try {
        const parsed = navigationSchema.safeParse(
            await context.access.send(
                targetId,
                "Runtime.evaluate",
                { expression: NAVIGATION_TIMING_EXPRESSION, returnByValue: true },
                METRICS_TIMEOUT_MS,
            ),
        );

        if (!parsed.success || parsed.data.result.type === "undefined") return undefined;

        const value = parsed.data.result.value;

        if (value === undefined || value === null) return undefined;

        const phases = Object.fromEntries(
            Object.entries(value).filter(([, phase]) => typeof phase === "number"),
        );

        return Object.keys(phases).length === 0 ? undefined : phases;
    } catch {
        return undefined;
    }
}
