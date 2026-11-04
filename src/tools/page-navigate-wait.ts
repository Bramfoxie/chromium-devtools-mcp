import { z } from "zod";

export const waitUntilSchema = z.enum(["load", "domcontentloaded", "none"]);

export type WaitUntil = z.infer<typeof waitUntilSchema>;

export interface NavigationWaitState {
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

export const frameSchema = z.object({
    frame: z.object({ id: z.string(), loaderId: z.string() }),
});

const lifecycleSchema = z.object({
    frameId : z.string(),
    loaderId: z.string(),
    name    : z.string(),
});

export const responseSchema = z.object({
    frameId : z.string().optional(),
    loaderId: z.string(),
    type    : z.string(),
    response: z.object({ status: z.number() }),
});

const stoppedSchema = z.object({ frameId: z.string(), loaderId: z.string().optional() });

export function toWaitEvent(
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
