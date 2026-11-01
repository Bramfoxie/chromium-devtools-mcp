import { z } from "zod";
import { defineTool, type ToolContext } from "./define-tool.js";
import { assertNoDialog } from "./dialogs.js";
import { emulationSummarySchema, summarizeEmulation } from "./emulation/summary.js";
import { ToolError } from "./errors.js";

const PAGE_INFO_TIMEOUT_MS = 5000;

export const pageInfoExpression = `(() => {
  const doc = document.documentElement;
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    scroll: {
      x: window.scrollX,
      y: window.scrollY,
      maxX: doc ? Math.max(0, doc.scrollWidth - window.innerWidth) : 0,
      maxY: doc ? Math.max(0, doc.scrollHeight - window.innerHeight) : 0,
    },
  };
})()`;

const pageInfoValue = z.strictObject({
    url       : z.string(),
    title     : z.string(),
    readyState: z.string(),
    viewport  : z.strictObject({
        width           : z.number(),
        height          : z.number(),
        devicePixelRatio: z.number(),
    }),
    scroll: z.strictObject({ x: z.number(), y: z.number(), maxX: z.number(), maxY: z.number() }),
});

const evaluatedSchema = z.strictObject({
    result: z.strictObject({
        type : z.string().optional(),
        value: z.unknown().optional(),
    }),
});

export function pageDetails(value: unknown): z.infer<typeof pageInfoValue> | undefined {
    const parsed = pageInfoValue.safeParse(value);

    return parsed.success ? parsed.data : undefined;
}

export const pageInfo = defineTool({
    name       : "page_info",
    description: "Read the URL, title, viewport and scroll position of a tab.",
    access     : "read",
    input      : z.strictObject({
        tab: z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
    }),
    output: z.strictObject({
        tab       : z.string().describe("Tab id."),
        url       : z.string().describe("URL of the tab."),
        title     : z.string().describe("Title of the tab."),
        readyState: z.string().describe("Document ready state, or unknown when the page is unresponsive."),
        viewport  : z.strictObject({
            width           : z.number().describe("Inner width in CSS pixels."),
            height          : z.number().describe("Inner height in CSS pixels."),
            devicePixelRatio: z.number().describe("Device pixel ratio."),
        }),
        scroll: z.strictObject({
            x   : z.number().describe("Horizontal scroll offset."),
            y   : z.number().describe("Vertical scroll offset."),
            maxX: z.number().describe("Maximum horizontal scroll offset."),
            maxY: z.number().describe("Maximum vertical scroll offset."),
        }),
        selected : z.boolean().describe("Whether the tab is the selected one."),
        owned    : z.boolean().describe("Whether the session owns the tab."),
        source   : z.enum(["page", "tab-list"]).describe("Whether the data came from the page or the tab list fallback."),
        emulation: emulationSummarySchema.optional().describe("Emulation overrides active on the tab, when any."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        assertNoDialog(context.dialogs, targetId);

        const tabs = await context.access.listTabs("owned");
        const known = tabs.find((tab) => tab.targetId === targetId);

        if (known) {
            context.tabs.refresh(tabs, context.state.selected);
        }

        let live: z.infer<typeof pageInfoValue> | undefined;

        try {
            const result = await context.access.send(
                targetId,
                "Runtime.evaluate",
                { expression: pageInfoExpression, returnByValue: true },
                PAGE_INFO_TIMEOUT_MS,
            );
            const evaluated = evaluatedSchema.safeParse(result);

            if (evaluated.success && evaluated.data.result.type !== "undefined") {
                live = pageDetails(evaluated.data.result.value);
            }
        } catch {
            live = undefined;
        }

        const emulation = summarizeEmulation(context.emulation.snapshot(targetId));

        if (live) {
            return {
                tab       : targetId,
                url       : live.url,
                title     : live.title,
                readyState: live.readyState,
                viewport  : live.viewport,
                scroll    : live.scroll,
                selected  : context.state.selected === targetId,
                owned     : true,
                source    : "page" as const,
                emulation,
            };
        }

        if (!known) {
            throw new ToolError(
                "The tab is not available in this session and the page did not answer. Call list_tabs to see the open tabs.",
            );
        }

        return {
            tab       : targetId,
            url       : known.url,
            title     : known.title,
            readyState: "unknown",
            viewport  : { width: 0, height: 0, devicePixelRatio: 1 },
            scroll    : { x: 0, y: 0, maxX: 0, maxY: 0 },
            selected  : context.state.selected === targetId,
            owned     : true,
            source    : "tab-list" as const,
            emulation,
        };
    },
});

export type PageContext = ToolContext;
