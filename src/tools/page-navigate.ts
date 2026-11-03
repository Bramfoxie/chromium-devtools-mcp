import { z } from "zod";
import { normalizeUrl } from "../daemon/index.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import { createDeadline, type Deadline, sendWithin } from "./deadline.js";
import { ensureNoDialog } from "./dialogs.js";
import { DomainRefusal, requireAllowedFinalUrl } from "./final-url.js";
import { describeUrlHost, isRestricted, isUrlAllowed } from "../safety/index.js";
import { ToolError } from "./errors.js";
import { throwIfCancelled } from "./registry.js";
import { resolveTab, tabSchema } from "./tab-target.js";

export const NAVIGATE_DEFAULT_TIMEOUT_MS = 30_000;

export const NAVIGATE_MAX_TIMEOUT_MS = 120_000;

const waitUntilSchema = z.enum(["load", "domcontentloaded", "none"]);

type WaitUntil = z.infer<typeof waitUntilSchema>;

interface NavigationWaitState {
    loaderId : string | undefined;
    navigated: boolean;
    stopped  : boolean;
    status   : number | undefined;
    done     : boolean;
}

type NavigationWaitEvent =
    | { type: "navigated"; loaderId: string }
    | { type: "lifecycle"; loaderId: string; name: string }
    | { type: "response"; loaderId: string; status: number }
    | { type: "stopped"; loaderId: string | undefined }
    | { type: "sameDocument" };

export function navigationWaitStart(loaderId?: string): NavigationWaitState {
    return { loaderId, navigated: false, stopped: false, status: undefined, done: false };
}

export function navigationWaitReduce(
    state: NavigationWaitState,
    event: NavigationWaitEvent,
    wait : Exclude<WaitUntil, "none">,
): NavigationWaitState {
    switch (event.type) {
        case "navigated": {
            const resumed = state.stopped &&
                (state.loaderId === undefined || event.loaderId === state.loaderId);

            return {
                ...state,
                loaderId : event.loaderId,
                navigated: true,
                status   : event.loaderId === state.loaderId ? state.status : undefined,
                done     : state.done || resumed,
            };
        }

        case "lifecycle": {
            const wanted = wait === "load" ? "load" : "DOMContentLoaded";

            if (!state.done && event.name === wanted && event.loaderId === state.loaderId) {
                return { ...state, done: true };
            }

            return state;
        }

        case "response":
            if (state.loaderId === undefined || event.loaderId === state.loaderId) {
                return { ...state, loaderId: event.loaderId, status: event.status };
            }

            return state;

        case "stopped": {
            if (!state.navigated) return { ...state, stopped: true };

            if (
                event.loaderId !== undefined && state.loaderId !== undefined &&
                event.loaderId !== state.loaderId
            ) {
                return state;
            }

            if (!state.done) return { ...state, stopped: true, done: true };

            return { ...state, stopped: true };
        }

        case "sameDocument":
            return { ...state, done: true };
    }
}

const historyEntry = z.object({ id: z.number(), url: z.string(), title: z.string() });

const historySchema = z.object({
    currentIndex: z.number(),
    entries     : z.array(historyEntry),
});

const navigateSchema = z.object({
    loaderId  : z.string().optional(),
    errorText : z.string().optional(),
    isDownload: z.boolean().optional(),
});

const frameSchema = z.object({
    frame: z.object({ id: z.string(), loaderId: z.string() }),
});

const lifecycleSchema = z.object({
    frameId : z.string(),
    loaderId: z.string(),
    name    : z.string(),
});

const responseSchema = z.object({
    frameId : z.string().optional(),
    loaderId: z.string(),
    type    : z.string(),
    response: z.object({ status: z.number() }),
});

const stoppedSchema = z.object({ frameId: z.string(), loaderId: z.string().optional() });

const pageStateSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z
            .object({ url: z.string(), title: z.string(), readyState: z.string() })
            .optional(),
    }),
});

export const PAGE_STATE_EXPRESSION =
    "({url: location.href, title: document.title, readyState: document.readyState})";

const MAIN_FRAME_EVENTS = [
    "Page.frameNavigated",
    "Page.frameStoppedLoading",
    "Page.lifecycleEvent",
    "Page.navigatedWithinDocument",
    "Network.responseReceived",
];

function mainFrameId(context: ToolContext, targetId: string): Promise<string | undefined> {
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

async function currentPage(
    context : ToolContext,
    targetId: string,
): Promise<{ url: string; title: string; readyState: string }> {
    const fallback = { url: "", title: "", readyState: "unknown" };

    try {
        const result = await context.access.send(
            targetId,
            "Runtime.evaluate",
            { expression: PAGE_STATE_EXPRESSION, returnByValue: true },
            5000,
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

async function historyEntryId(
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

export const pageNavigate = defineTool({
    name: "page_navigate",
    description:
        "Navigate a tab to a URL, back, forward or reload it, waiting for the page to load.",
    access: "mutate",
    input : z.strictObject({
        tab        : tabSchema,
        action     : z.enum(["url", "back", "forward", "reload"]).optional().describe("What to do. Defaults to url."),
        url        : z.string().min(1).max(2048).optional().describe("URL to open, http, https or about:blank. Required for the url action."),
        waitUntil  : waitUntilSchema.optional().describe("Wait for the load event, DOMContentLoaded, or return at once. Defaults to load."),
        timeoutMs  : z.number().int().min(1).max(NAVIGATE_MAX_TIMEOUT_MS).optional().describe("How long to wait for the page. Defaults to 30000 ms."),
        ignoreCache: z.boolean().optional().describe("Reload ignoring the cache. Only for the reload action."),
    }),
    output: z.strictObject({
        tab           : z.string().describe("Tab id."),
        url           : z.string().describe("Final URL of the tab."),
        title         : z.string().describe("Final title of the tab."),
        status        : z.number().optional().describe("HTTP status of the main document, when observed."),
        waited        : z.enum(["load", "domcontentloaded", "none", "timeout"]).describe("What the tool waited for."),
        navigationType: z.string().describe("The navigation action that ran."),
        readyState    : z.string().optional().describe("Document ready state, reported when the wait timed out."),
    }),
    target: (args) =>
        args.action === undefined || args.action === "url"
            ? args.url === undefined
                ? undefined
                : { url: args.url }
            : undefined,
    tabUrlExempt: (args) => (args.action ?? "url") === "url",
    handler     : async (args, context) => {
        const targetId = resolveTab(args, context);

        const action = args.action ?? "url";

        if (action === "url" && args.url === undefined) {
            throw new ToolError("The url action needs a url to open.");
        }

        const waitUntil = args.waitUntil ?? "load";
        const timeoutMs = args.timeoutMs ?? NAVIGATE_DEFAULT_TIMEOUT_MS;

        throwIfCancelled(context.signal);

        await ensureNoDialog(context.dialogs, targetId);

        const deadline = createDeadline(context.signal, timeoutMs, () => context.clock.now());

        try {
            if (waitUntil === "none") {
                await navigate(context, deadline, targetId, action, args.url, args.ignoreCache);
                const page = await currentPage(context, targetId);

                await requireAllowedFinalUrl(context, targetId, page.url);

                return {
                    tab           : targetId,
                    url           : page.url,
                    title         : page.title,
                    waited        : "none" as const,
                    navigationType: action,
                };
            }

            const state = await navigateAndWait(
                context,
                deadline,
                targetId,
                action,
                args.url,
                args.ignoreCache,
                waitUntil,
            );
            const page = await currentPage(context, targetId);

            await requireAllowedFinalUrl(context, targetId, page.url);

            const waited: "load" | "domcontentloaded" | "timeout" = state.done ? waitUntil : "timeout";

            return {
                tab           : targetId,
                url           : page.url,
                title         : page.title,
                ...(state.status === undefined ? {} : { status: state.status }),
                waited,
                navigationType: action,
                ...(waited === "timeout" ? { readyState: page.readyState } : {}),
            };
        } catch (error) {
            if (error instanceof DomainRefusal) throw error;

            if (deadline.expired() && !context.signal.aborted) {
                throw new ToolError(
                    `The navigation did not start within ${timeoutMs} ms. The page may still be loading; check it with page_info or raise timeoutMs.`,
                );
            }

            throw error;
        } finally {
            deadline.dispose();
            context.elements.nextGeneration(targetId);
        }
    },
});

export interface TabLoad {
    waited          : "load" | "timeout" | "none";
    page            : { url: string; title: string; readyState: string };
    status?         : number;
    navigationError?: string;
}

export async function loadInTab(
    context  : ToolContext,
    targetId : string,
    url      : string,
    timeoutMs: number,
): Promise<TabLoad> {
    const deadline = createDeadline(context.signal, timeoutMs, () => context.clock.now());

    try {
        const state = await navigateAndWait(
            context,
            deadline,
            targetId,
            "url",
            url,
            undefined,
            "load",
        );

        return {
            waited: state.done ? "load" : "timeout",
            page  : await currentPage(context, targetId),
            ...(state.status === undefined ? {} : { status: state.status }),
        };
    } catch (error) {
        if (context.signal.aborted) throw error;

        if (deadline.expired()) {
            return { waited: "timeout", page: await currentPage(context, targetId) };
        }

        if (error instanceof ToolError) {
            return {
                waited         : "none",
                page           : await currentPage(context, targetId),
                navigationError: error.message,
            };
        }

        throw error;
    } finally {
        deadline.dispose();
        context.elements.nextGeneration(targetId);
    }
}

async function navigate(
    context    : ToolContext,
    deadline   : Deadline,
    targetId   : string,
    action     : "url" | "back" | "forward" | "reload",
    url        : string | undefined,
    ignoreCache: boolean | undefined,
): Promise<string | undefined> {
    switch (action) {
        case "back":

        case "forward": {
            const entryId = await historyEntryId(context, targetId, action);

            await sendWithin(context.access, deadline, targetId, "Page.navigateToHistoryEntry", {
                entryId,
            });

            return undefined;
        }

        case "reload":
            await sendWithin(context.access, deadline, targetId, "Page.reload", {
                ...(ignoreCache === true ? { ignoreCache: true } : {}),
            });

            return undefined;

        case "url": {
            const result = navigateSchema.safeParse(
                await sendWithin(context.access, deadline, targetId, "Page.navigate", { url }),
            );

            if (!result.success) {
                throw new ToolError(
                    "The browser sent an unexpected response to Page.navigate. Try the call again.",
                );
            }

            if (result.data.isDownload === true) {
                throw new ToolError(
                    "The URL is a file download, so the tab was not navigated and still shows its previous page.",
                );
            }

            if (result.data.errorText === "net::ERR_ABORTED") {
                throw new ToolError(
                    "The navigation was aborted, for example by an empty 204 response or a download, so the tab still shows its previous page.",
                );
            }

            if (result.data.errorText !== undefined && result.data.errorText !== "") {
                throw new ToolError(
                    `Navigation to the page failed: ${result.data.errorText}. Check the URL and try again.`,
                );
            }

            return result.data.loaderId;
        }
    }
}

async function navigateAndWait(
    context    : ToolContext,
    deadline   : Deadline,
    targetId   : string,
    action     : "url" | "back" | "forward" | "reload",
    url        : string | undefined,
    ignoreCache: boolean | undefined,
    wait       : Exclude<WaitUntil, "none">,
): Promise<NavigationWaitState> {
    const frameId = await mainFrameId(context, targetId);
    let state = navigationWaitStart();
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const onEvent = (params: unknown) => {
        const envelope = params as {
            targetId?: unknown;
            event?   : unknown;
            params?  : unknown;
        } | null;

        if (envelope?.targetId !== targetId) return;

        const event = toWaitEvent(envelope.event, envelope.params, frameId);

        if (event === undefined) return;

        state = navigationWaitReduce(state, event, wait);

        if (state.done) finish();
    };
    const off = context.access.on("cdp.event", onEvent);
    const keepNetwork = context.capture.networkEnabled(targetId);
    const keepPage = context.dialogs.pageEnabled(targetId);
    const subscribed: string[] = [];

    try {
        await sendWithin(context.access, deadline, targetId, "Page.enable", {});
        await sendWithin(context.access, deadline, targetId, "Page.setLifecycleEventsEnabled", {
            enabled: true,
        });

        if (!keepNetwork) await sendWithin(context.access, deadline, targetId, "Network.enable", {});

        for (const event of MAIN_FRAME_EVENTS) {
            await context.access.subscribe(targetId, event);
            subscribed.push(event);
        }

        throwIfCancelled(context.signal);

        state = navigationWaitStart();

        const started = await navigate(context, deadline, targetId, action, url, ignoreCache);

        if (started !== undefined && state.loaderId === undefined) {
            state = { ...state, loaderId: started };
        }

        await Promise.race([
            finished,
            context.clock.sleep(deadline.remainingMs()),
            new Promise<void>((resolve) => {
                if (context.signal.aborted) {
                    resolve();

                    return;
                }

                context.signal.addEventListener("abort", () => resolve(), { once: true });
            }),
        ]);
        throwIfCancelled(context.signal);

        return state;
    } finally {
        off();

        for (const event of subscribed) {
            await context.access.unsubscribe(targetId, event).catch(() => undefined);
        }

        if (keepPage) {
            await context.access
                .send(targetId, "Page.setLifecycleEventsEnabled", { enabled: false })
                .catch(() => undefined);
        } else {
            await context.access.send(targetId, "Page.disable", {}).catch(() => undefined);
        }

        if (!keepNetwork) {
            await context.access.send(targetId, "Network.disable", {}).catch(() => undefined);
        }
    }
}

function toWaitEvent(
    event  : unknown,
    params : unknown,
    frameId: string | undefined,
): NavigationWaitEvent | undefined {
    if (event === "Page.frameNavigated") {
        const parsed = frameSchema.safeParse(params);

        if (parsed.success && (frameId === undefined || parsed.data.frame.id === frameId)) {
            return { type: "navigated", loaderId: parsed.data.frame.loaderId };
        }

        return undefined;
    }

    if (event === "Page.lifecycleEvent") {
        const parsed = lifecycleSchema.safeParse(params);

        if (parsed.success && (frameId === undefined || parsed.data.frameId === frameId)) {
            return { type: "lifecycle", loaderId: parsed.data.loaderId, name: parsed.data.name };
        }

        return undefined;
    }

    if (event === "Network.responseReceived") {
        const parsed = responseSchema.safeParse(params);

        if (
            parsed.success && parsed.data.type === "Document" &&
            (frameId === undefined || parsed.data.frameId === frameId)
        ) {
            return { type: "response", loaderId: parsed.data.loaderId, status: parsed.data.response.status };
        }

        return undefined;
    }

    if (event === "Page.frameStoppedLoading") {
        const parsed = stoppedSchema.safeParse(params);

        if (parsed.success && (frameId === undefined || parsed.data.frameId === frameId)) {
            return { type: "stopped", loaderId: parsed.data.loaderId };
        }

        return undefined;
    }

    if (event === "Page.navigatedWithinDocument") {
        const parsed = stoppedSchema.safeParse(params);

        if (parsed.success && (frameId === undefined || parsed.data.frameId === frameId)) {
            return { type: "sameDocument" };
        }

        return undefined;
    }

    return undefined;
}
