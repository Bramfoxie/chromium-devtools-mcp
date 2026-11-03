import { z } from "zod";
import { normalizeUrl } from "../daemon/index.js";
import { type ToolContext } from "./define-tool.js";
import { describeUrlHost, isRestricted, isUrlAllowed } from "../safety/index.js";
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
        .send(targetId, "Page.getFrameTree", {})
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
        const result = await context.access.send(
            targetId,
            "Runtime.evaluate",
            { expression: PAGE_STATE_EXPRESSION, returnByValue: true },
            PAGE_STATE_TIMEOUT_MS,
        );
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
        await context.access.send(targetId, "Page.getNavigationHistory", {}),
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

    const domains = context.config.safety.allowedDomains;

    if (isRestricted(domains) && !isUrlAllowed(entry.url, domains)) {
        throw new ToolError(
            `The ${direction === "back" ? "previous" : "next"} history entry is on ${describeUrlHost(entry.url)}, which is outside safety.allowedDomains. Navigate to an allowed domain instead, or ask the owner to add it to safety.allowedDomains.`,
        );
    }

    if (!isOpenableUrl(entry.url)) {
        throw new ToolError(
            `The ${direction === "back" ? "previous" : "next"} history entry is not an http, https or about:blank page. Only http, https and about:blank URLs can be opened.`,
        );
    }

    return entry.id;
}
