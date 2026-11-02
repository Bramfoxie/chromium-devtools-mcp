import { ErrorCode, IpcCancelledError, RpcError } from "../../src/daemon/index.js";
import type { DaemonAccess, DaemonFrame, DaemonTab, SessionSummary } from "../../src/mcp/index.js";

export interface FakeAccessOptions {
    tabs?    : DaemonTab[];
    sessions?: SessionSummary[];
    frames?  : DaemonFrame[];
    evaluate?: unknown;
}

export class FakeAccess {
    tabs            : DaemonTab[];
    sessions        : SessionSummary[];
    frames          : DaemonFrame[];
    readonly created: string[] = [];
    readonly closed : string[] = [];
    readonly claimed: string[] = [];
    readonly sent: Array<{
        targetId  : string;
        method    : string;
        params?   : Record<string, unknown>;
        timeoutMs?: number;
        frameId?  : string;
    }> = [];
    readonly order       : string[] = [];
    readonly subscribed  : Array<{ targetId: string; event: string; frameId?: string }> = [];
    readonly unsubscribed: Array<{ targetId: string; event: string; frameId?: string }> = [];
    readonly events = new Map<string, Set<(params: unknown) => void>>();
    readonly resets = new Set<() => void>();
    generation = 0;
    failSend?            : (targetId: string, method: string) => Error | undefined;
    respond?                 : (
        targetId: string,
        method  : string,
        params? : Record<string, unknown>,
    ) => unknown;
    private readonly evaluate: unknown;
    private counter = 0;

    constructor(options: FakeAccessOptions = {}) {
        this.tabs = options.tabs ?? [];
        this.sessions = options.sessions ?? [];
        this.frames = options.frames ?? [];
        this.evaluate = options.evaluate;
    }

    get sessionGeneration(): number {
        return this.generation;
    }

    on(event: string, handler: (params: unknown) => void): () => void {
        let set = this.events.get(event);

        if (!set) {
            set = new Set();
            this.events.set(event, set);
        }

        set.add(handler);

        return () => void set.delete(handler);
    }

    onSessionReset(handler: () => void): () => void {
        this.resets.add(handler);

        return () => void this.resets.delete(handler);
    }

    forgetStaleState(onReset: () => void): () => void {
        return this.onSessionReset(onReset);
    }

    bumpGeneration(): void {
        this.generation += 1;
        for (const handler of [...this.resets]) handler();
    }

    async createTab(url?: string): Promise<string> {
        const targetId = `tab${(this.counter += 1)}`;

        this.tabs.push({
            targetId,
            url    : url ?? "about:blank",
            title  : `title of ${url ?? "about:blank"}`,
            owned  : true,
            created: true,
        });
        this.created.push(targetId);

        return targetId;
    }

    async listTabs(scope: "owned" | "available"): Promise<DaemonTab[]> {
        if (scope === "available") return this.tabs.filter((tab) => !tab.owned).map((tab) => ({ ...tab }));

        return this.tabs.filter((tab) => tab.owned).map((tab) => ({ ...tab }));
    }

    async claimTab(targetId: string): Promise<void> {
        const tab = this.tabs.find((known) => known.targetId === targetId);

        if (!tab) {
            throw new RpcError(ErrorCode.notFound, "No such tab is available to this session.");
        }

        if (tab.owned) return;

        tab.owned = true;
        this.claimed.push(targetId);
    }

    async closeTab(targetId: string): Promise<void> {
        const tab = this.tabs.find((known) => known.targetId === targetId);

        if (!tab || !tab.owned) {
            throw new RpcError(ErrorCode.notFound, "No such tab in this session.");
        }

        if (!tab.created) {
            throw new RpcError(
                ErrorCode.notCreated,
                "Only tabs opened by this session can be closed.",
            );
        }

        this.tabs = this.tabs.filter((known) => known.targetId !== targetId);
        this.closed.push(targetId);
    }

    async listSessions(): Promise<SessionSummary[]> {
        return [...this.sessions];
    }

    async listFrames(targetId: string): Promise<DaemonFrame[]> {
        void targetId;

        return this.frames.map((frame) => ({ ...frame }));
    }

    async send(
        targetId  : string,
        method    : string,
        params?   : Record<string, unknown>,
        timeoutMs?: number,
        frameId?  : string,
        options?  : { signal?: AbortSignal },
    ): Promise<unknown> {
        this.sent.push({ targetId, method, params, timeoutMs, frameId });
        this.order.push(`send ${method}`);
        const failure = this.failSend?.(targetId, method);

        if (failure) throw failure;

        if (method === "Page.enable") return {};

        const answer = this.respond?.(targetId, method, params) ?? this.evaluate ?? {
            result: { type: "undefined" },
        };

        if (options?.signal === undefined) return answer;

        return abortable(Promise.resolve(answer), options.signal);
    }

    async subscribe(targetId: string, event: string, frameId?: string): Promise<void> {
        this.subscribed.push({ targetId, event, frameId });
        this.order.push(`subscribe ${event}`);
    }

    async unsubscribe(targetId: string, event: string, frameId?: string): Promise<void> {
        this.unsubscribed.push({ targetId, event, frameId });
    }

    emit(event: string, params: unknown): void {
        for (const handler of [...(this.events.get(event) ?? [])]) handler(params);
    }

    assertCurrent(): void {}

    asAccess(): DaemonAccess {
        return this as unknown as DaemonAccess;
    }
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new IpcCancelledError("cdp.send"));

    return new Promise<T>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new IpcCancelledError("cdp.send")), {
            once: true,
        });
        work.then(resolve, reject);
    });
}
