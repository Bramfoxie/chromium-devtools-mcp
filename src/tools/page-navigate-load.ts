import { type ToolContext } from "./define-tool.js";
import { createDeadline, type Deadline, sendWithin } from "./deadline.js";
import { ToolError } from "./errors.js";
import { throwIfCancelled } from "./registry.js";
import { WaitUntil, NavigationWaitState, navigationWaitStart, navigationWaitReduce, toWaitEvent } from "./page-navigate-wait.js";
import { navigateSchema, MAIN_FRAME_EVENTS, mainFrameId, currentPage, historyEntryId } from "./page-navigate-state.js";

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

export async function navigate(
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

export async function navigateAndWait(
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
                .send({
                    targetId,
                    method: "Page.setLifecycleEventsEnabled",
                    params: { enabled: false },
                })
                .catch(() => undefined);
        } else {
            await context.access.send({
                targetId,
                method: "Page.disable",
                params: {},
            }).catch(() => undefined);
        }

        if (!keepNetwork) {
            await context.access.send({
                targetId,
                method: "Network.disable",
                params: {},
            }).catch(() => undefined);
        }
    }
}
