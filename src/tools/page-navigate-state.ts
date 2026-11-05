import { z } from "zod";
import { normalizeUrl } from "../daemon/index.js";
import { type ToolContext } from "./define-tool.js";
import { describeBlock, describeUrlHost, navigationBlock } from "../safety/index.js";
import { ToolError } from "./errors.js";

const historyEntry = z.object({ id: z.number(), url: z.string(), title: z.string() });

export const historySchema = z.object({
    currentIndex: z.number(),
    entries     : z.array(historyEntry),
});

export const navigateSchema = z.object({
    loaderId  : z.string().optional(),
    errorText : z.string().optional(),
    isDownload: z.boolean().optional(),
});

const pageStateSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z
            .object({ url: z.string(), title: z.string(), readyState: z.string() })
            .optional(),
    }),
});

const PAGE_STATE_TIMEOUT_MS = 5000;

export const PAGE_STATE_EXPRESSION =
    "({url: location.href, title: document.title, readyState: document.readyState})";

export const MAIN_FRAME_EVENTS = [
    "Page.frameNavigated",
    "Page.frameStoppedLoading",
    "Page.lifecycleEvent",
    "Page.navigatedWithinDocument",
    "Network.responseReceived",
];

export function mainFrameId(context: ToolContext, targetId: string): Promise<string | undefined> {
    return context.access
        .send({
            targetId,
            method: "Page.getFrameTree",
            params: {},
        })
        .then(
            (tree) =>
                (tree as { frameTree?: { frame?: { id?: unknown } } } | null)?.frameTree?.frame
                    ?.id,
        )
        .then((id) => (typeof id === "string" ? id : undefined))
        .catch(() => undefined);
}

export async function currentPage(
    context : ToolContext,
    targetId: string,
): Promise<{ url: string; title: string; readyState: string }> {
    const fallback = { url: "", title: "", readyState: "unknown" };

    try {
        const result = await context.access.send({
            targetId,
            method   : "Runtime.evaluate",
            params   : { expression: PAGE_STATE_EXPRESSION, returnByValue: true },
            timeoutMs: PAGE_STATE_TIMEOUT_MS,
        });
        const parsed = pageStateSchema.safeParse(result);

        if (parsed.success && parsed.data.result.type !== "undefined") {
            return parsed.data.result.value ?? fallback;
        }
    } catch {
    }

    return fallback;
}

function isOpenableUrl(url: string): boolean {
    try {
        normalizeUrl(url);

        return true;
    } catch {
        return false;
    }
}

export async function historyEntryId(
    context  : ToolContext,
    targetId : string,
    direction: "back" | "forward",
): Promise<number> {
    const history = historySchema.safeParse(
        await context.access.send({
            targetId,
            method: "Page.getNavigationHistory",
            params: {},
        }),
    );

    if (!history.success) {
        throw new ToolError(
            "The browser sent an unexpected navigation history. Try the call again.",
        );
    }

    const index = history.data.currentIndex + (direction === "back" ? -1 : 1);
    const entry = history.data.entries[index];

    if (entry === undefined) {
        throw new ToolError(
            direction === "back"
                ? "There is no page to go back to in this tab."
                : "There is no page to go forward to in this tab.",
        );
    }

    const block = navigationBlock(entry.url, context.config.safety);

    if (block !== undefined) {
        const described = describeBlock(block);
        const which = direction === "back" ? "previous" : "next";

        throw new ToolError(
            `The ${which} history entry is on ${describeUrlHost(entry.url)}, ${described.reason}. ${described.hint}`,
        );
    }

    if (!isOpenableUrl(entry.url)) {
        throw new ToolError(
            `The ${direction === "back" ? "previous" : "next"} history entry is not an http, https or about:blank page. Only http, https and about:blank URLs can be opened.`,
        );
    }

    return entry.id;
}
