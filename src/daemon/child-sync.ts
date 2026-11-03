const REPLICATED = new Set([
    "Network.enable",
    "Runtime.enable",
    "Log.enable",
    "Page.enable",
    "Fetch.enable",
    "Network.emulateNetworkConditions",
    "Network.setBlockedURLs",
    "Emulation.setUserAgentOverride",
    "Emulation.setLocaleOverride",
    "Emulation.setTimezoneOverride",
    "Emulation.setEmulatedMedia",
]);

const REQUEST_ROUTED = new Set([
    "Fetch.continueRequest",
    "Fetch.fulfillRequest",
    "Fetch.failRequest",
    "Fetch.continueResponse",
    "Fetch.continueWithAuth",
    "Fetch.getResponseBody",
    "Fetch.takeResponseBodyAsStream",
    "Network.getResponseBody",
    "Network.getRequestPostData",
]);

const MIRRORED_PREFIXES = ["Network.", "Fetch.", "Log."];

const MIRRORED_EVENTS = new Set([
    "Runtime.consoleAPICalled",
    "Runtime.exceptionThrown",
    "Page.javascriptDialogOpening",
    "Page.javascriptDialogClosed",
    "Page.frameAttached",
    "Page.frameNavigated",
    "Page.frameDetached",
]);

const MAX_ROUTES = 4096;

export interface ReplayCommand {
    method: string;
    params: Record<string, unknown> | undefined;
}

export function isMirroredEvent(event: string): boolean {
    return MIRRORED_EVENTS.has(event) ||
        MIRRORED_PREFIXES.some((prefix) => event.startsWith(prefix));
}

export function isReplicated(method: string): boolean {
    return REPLICATED.has(method) || isDisable(method);
}

function isDisable(method: string): boolean {
    return method.endsWith(".disable") && REPLICATED.has(`${method.slice(0, -".disable".length)}.enable`);
}

// Tracks per tab state that must also reach child sessions of cross-site frames.
export class ChildSync {
    private readonly sticky = new Map<string, ReplayCommand>();
    private readonly routes = new Map<string, string>();
    private dialogSession: string | undefined;

    record(method: string, params: Record<string, unknown> | undefined): void {
        if (isDisable(method)) {
            this.sticky.delete(`${method.slice(0, -".disable".length)}.enable`);

            return;
        }

        if (!REPLICATED.has(method)) return;

        this.sticky.delete(method);
        this.sticky.set(method, { method, params });
    }

    replay(): ReplayCommand[] {
        return [...this.sticky.values()];
    }

    note(sessionId: string, event: string, params: unknown): void {
        if (event === "Page.javascriptDialogOpening") this.dialogSession = sessionId;

        if (event === "Page.javascriptDialogClosed" && this.dialogSession === sessionId) {
            this.dialogSession = undefined;
        }

        const requestId = (params as { requestId?: unknown } | null)?.requestId;

        if (typeof requestId !== "string") return;

        this.routes.delete(requestId);
        this.routes.set(requestId, sessionId);

        if (this.routes.size > MAX_ROUTES) {
            const oldest = this.routes.keys().next().value;

            if (oldest !== undefined) this.routes.delete(oldest);
        }
    }

    routeOf(method: string, params: Record<string, unknown> | undefined): string | undefined {
        if (method === "Page.handleJavaScriptDialog") return this.dialogSession;

        if (!REQUEST_ROUTED.has(method)) return undefined;

        const requestId = params?.requestId;

        return typeof requestId === "string" ? this.routes.get(requestId) : undefined;
    }

    release(sessionId: string): void {
        if (this.dialogSession === sessionId) this.dialogSession = undefined;

        for (const [requestId, owner] of [...this.routes]) {
            if (owner === sessionId) this.routes.delete(requestId);
        }
    }
}
