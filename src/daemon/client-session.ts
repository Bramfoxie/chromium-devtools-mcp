import { ChildSync, isMirroredEvent, isReplicated } from "./child-sync.js";
import type { FrameSummary } from "./frames.js";
import type { BrowserBackend, TargetInfo } from "./browser-backend.js";
import { RpcError } from "./errors.js";
import { describeError, logDaemon } from "../util/log.js";
import {
    checkGuardedCall,
    checkOpenUrl,
    needsTabUrl,
    NO_SAFETY,
    type SessionSafety,
} from "./cdp-safety.js";
import { checkCall, checkEvent } from "./method-policy.js";
import { ErrorCode } from "./protocol.js";
import { closedError, tabGone, translate } from "./rpc-errors.js";
import type { TabInfo } from "./wire.js";
import { type OwnedTab, type Subscription, TabFrames } from "./tab-frames.js";

const DETACH_GRACE_MS = 2000;

export interface SessionOptions {
    allowFocus: boolean;
}

export type TabScope = "owned" | "available";

export interface SendCall {
    targetId  : string;
    method    : string;
    params?   : Record<string, unknown> | undefined;
    timeoutMs?: number | undefined;
    frameId?  : string | undefined;
    confirmed?: boolean | undefined;
}

export interface ClientSessionInit {
    backend    : BrowserBackend;
    registry   : Ownership;
    emit       : Emit;
    options    : SessionOptions;
    contextId  : string | undefined;
    clientName?: string;
    safety?    : SessionSafety;
}

export type Emit = (event: string, params?: unknown) => void;

export interface Ownership {
    ownerOf(targetId: string): ClientSession | undefined;
    setOwner(targetId: string, session: ClientSession): void;
    releaseOwner(targetId: string, session: ClientSession): void;
    wasDestroyed(targetId: string): boolean;
}

function describe(target: TargetInfo, owned: boolean, created: boolean): TabInfo {
    return { targetId: target.targetId, url: target.url, title: target.title, owned, created };
}

async function within(promise: Promise<unknown>, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
    });

    await Promise.race([promise.then(() => undefined), expired]);
    clearTimeout(timer);
}

export class ClientSession {
    private readonly tabs = new Map<string, OwnedTab>();
    private readonly frames: TabFrames;
    private isClosed = false;

    private readonly backend : BrowserBackend;
    private readonly registry: Ownership;
    private readonly emit    : Emit;
    private readonly options : SessionOptions;
    readonly contextId       : string | undefined;
    readonly clientName      : string;
    private readonly safety  : SessionSafety;

    constructor(init: ClientSessionInit) {
        this.backend = init.backend;
        this.registry = init.registry;
        this.emit = init.emit;
        this.options = init.options;
        this.contextId = init.contextId;
        this.clientName = init.clientName ?? "";
        this.safety = init.safety ?? NO_SAFETY;
        this.frames = new TabFrames(this.backend, this.emit, (targetId, tab) =>
            this.assertCurrent(targetId, tab));
    }

    get isolated(): boolean {
        return this.contextId !== undefined;
    }

    get closed(): boolean {
        return this.isClosed;
    }

    get tabCount(): number {
        let count = 0;

        for (const tab of this.tabs.values()) {
            if (!tab.closing) count += 1;
        }

        return count;
    }

    async createTab(url: string): Promise<string> {
        this.ensureOpen();
        checkOpenUrl("tab.create", url, this.safety);
        let targetId: string;

        try {
            targetId = await this.backend.createTarget(url, this.contextId);
        } catch (error) {
            throw translate(error);
        }

        if (this.isClosed) {
            await this.backend.closeTarget(targetId).catch(() => undefined);

            throw closedError();
        }

        if (this.registry.wasDestroyed(targetId)) throw tabGone();

        this.registry.setOwner(targetId, this);
        this.tabs.set(targetId, {
            created      : true,
            closing      : false,
            frames       : new Map(),
            subscriptions: new Map(),
            sync         : new ChildSync(),
        });

        return targetId;
    }

    async claimTab(targetId: string): Promise<void> {
        this.ensureOpen();
        if (this.tabs.has(targetId)) return;

        this.ensureUnowned(targetId);
        const targets = await this.backend.listTargets();
        const target = targets.find((item) => item.targetId === targetId);

        if (!target || target.contextId !== this.contextId) {
            throw new RpcError(ErrorCode.notFound, "No such tab is available to this session.");
        }

        this.ensureOpen();
        this.ensureUnowned(targetId);
        if (this.registry.wasDestroyed(targetId)) throw tabGone();

        this.registry.setOwner(targetId, this);
        this.tabs.set(targetId, {
            created      : false,
            closing      : false,
            frames       : new Map(),
            subscriptions: new Map(),
            sync         : new ChildSync(),
        });
    }

    async closeTab(targetId: string): Promise<void> {
        this.ensureOpen();
        const tab = this.owned(targetId);

        if (!tab.created) {
            throw new RpcError(
                ErrorCode.notCreated,
                "Only tabs opened by this session can be closed. Release a claimed tab by ending the session.",
            );
        }

        tab.closing = true;

        try {
            await this.backend.closeTarget(targetId);
        } catch (error) {
            tab.closing = false;

            throw translate(error);
        }

        this.forget(targetId);
    }

    async listTabs(scope: TabScope): Promise<TabInfo[]> {
        this.ensureOpen();
        let targets: TargetInfo[];

        try {
            targets = await this.backend.listTargets();
        } catch (error) {
            throw translate(error);
        }

        const result: TabInfo[] = [];

        for (const target of targets) {
            const tab = this.tabs.get(target.targetId);

            if (scope === "owned" && tab && !tab.closing) {
                result.push(describe(target, true, tab.created));
            } else if (scope === "available" && this.isAvailable(target)) {
                result.push(describe(target, false, false));
            }
        }

        return result;
    }

    async send(call: SendCall): Promise<unknown> {
        const { targetId, method, params, timeoutMs, frameId, confirmed = false } = call;

        this.ensureOpen();
        const tab = this.owned(targetId);

        const checked = checkCall(method, params, this.options);

        await this.enforceSafety(targetId, tab, method, checked, frameId, confirmed);

        try {
            const session = await this.frames.sessionFor(targetId, tab, frameId);

            this.assertCurrent(targetId, tab);

            const routed = frameId === undefined
                ? await this.frames.routedChild(tab, method, checked)
                : undefined;

            if (routed !== undefined) return await routed.send(method, checked, timeoutMs);

            const result = await session.send(method, checked, timeoutMs);

            if (frameId === undefined && isReplicated(method)) {
                await this.frames.replicate(targetId, tab, method, checked);
            }

            return result;
        } catch (error) {
            throw translate(error);
        }
    }

    private async enforceSafety(
        targetId : string,
        tab      : OwnedTab,
        method   : string,
        params   : Record<string, unknown> | undefined,
        frameId  : string | undefined,
        confirmed: boolean,
    ): Promise<void> {
        if (method === "Page.navigate") {
            checkOpenUrl(method, String(params?.url), this.safety);

            return;
        }

        let tabUrl: string | undefined;

        if (needsTabUrl(method, this.safety)) {
            try {
                tabUrl = (await this.backend.listTargets()).find(
                    (target) => target.targetId === targetId,
                )?.url;
            } catch (error) {
                throw translate(error);
            }

            this.assertCurrent(targetId, tab);
        }

        checkGuardedCall({
            method,
            params,
            safety  : this.safety,
            confirmed,
            tabUrl,
            frameUrl: frameId === undefined ? undefined : tab.frames.get(frameId)?.summary.url,
        });
    }

    async subscribe(targetId: string, event: string, frameId?: string): Promise<void> {
        this.ensureOpen();
        const tab = this.owned(targetId);

        checkEvent(event);
        const key = frameId === undefined ? event : `${frameId}|${event}`;
        const known = tab.subscriptions.get(key);

        if (known !== undefined) {
            known.count += 1;

            return;
        }

        try {
            const session = await this.frames.sessionFor(targetId, tab, frameId);

            this.assertCurrent(targetId, tab);
            const current = tab.subscriptions.get(key);

            if (current !== undefined) {
                current.count += 1;

                return;
            }

            const stop = session.on(event, (params) =>
                this.emit("cdp.event", {
                    targetId,
                    event,
                    params,
                    ...(frameId === undefined ? {} : { frameId }),
                }));
            const mirrors = new Map<string, () => void>();
            const subscription: Subscription = {
                count: 1,
                off  : () => {
                    stop();
                    for (const off of mirrors.values()) off();
                    mirrors.clear();
                },
                mirrors,
            };

            if (frameId === undefined && isMirroredEvent(event)) {
                subscription.mirror = (child) =>
                    this.frames.mirror(targetId, tab, subscription, event, child);
            }

            tab.subscriptions.set(key, subscription);

            if (subscription.mirror !== undefined) {
                const children = await this.frames.childrenOf(targetId, tab).catch(() => undefined);

                for (const child of children?.children() ?? []) subscription.mirror(child);
            }
        } catch (error) {
            throw translate(error);
        }
    }

    unsubscribe(targetId: string, event: string, frameId?: string): void {
        this.ensureOpen();
        const tab = this.owned(targetId);
        const key = frameId === undefined ? event : `${frameId}|${event}`;
        const known = tab.subscriptions.get(key);

        if (known === undefined) return;

        known.count -= 1;

        if (known.count <= 0) {
            tab.subscriptions.delete(key);
            known.off();
        }
    }

    async listFrames(targetId: string): Promise<FrameSummary[]> {
        this.ensureOpen();
        const tab = this.owned(targetId);

        try {
            return await this.frames.list(targetId, tab);
        } catch (error) {
            throw translate(error);
        }
    }

    handleTargetDestroyed(targetId: string): void {
        const tab = this.tabs.get(targetId);

        if (!tab) return;

        this.forget(targetId);
        if (!tab.closing) this.emit("tab.closed", { targetId });
    }

    async close(): Promise<void> {
        if (this.isClosed) return;

        this.isClosed = true;
        const entries = [...this.tabs.entries()];

        this.tabs.clear();

        const claimed = new Set<string>();

        for (const [targetId, tab] of entries) {
            for (const entry of tab.subscriptions.values()) entry.off();

            if (!tab.created && this.contextId === undefined) {
                this.registry.releaseOwner(targetId, this);
                claimed.add(targetId);
            }
        }

        const detaches = Promise.all(
            entries.map(async ([, tab]) => {
                const session = await tab.attached?.catch(() => undefined);
                const children = await tab.children?.catch(() => undefined);

                await children?.detachAll().catch(() => undefined);
                await session?.detach().catch(() => undefined);
            }),
        );

        try {
            await Promise.all([this.dispose(entries), within(detaches, DETACH_GRACE_MS)]);
        } finally {
            for (const [targetId] of entries) {
                if (!claimed.has(targetId)) this.registry.releaseOwner(targetId, this);
            }
        }
    }

    private async dispose(entries: Array<[string, OwnedTab]>): Promise<void> {
        if (this.contextId !== undefined) {
            const contextId = this.contextId;

            await this.attempt("dispose the browser context", () =>
                this.backend.disposeContext(contextId),
            );

            return;
        }

        await Promise.all(
            entries
                .filter(([, tab]) => tab.created)
                .map(([targetId]) => this.attempt("close a tab", () => this.backend.closeTarget(targetId))),
        );
    }

    private isAvailable(target: TargetInfo): boolean {
        return target.contextId === this.contextId && !this.registry.ownerOf(target.targetId);
    }

    private async attempt(what: string, action: () => Promise<void>): Promise<void> {
        try {
            await action();
        } catch (error) {
            logDaemon(`could not ${what}: ${describeError(error)}`);
        }
    }

    private ensureOpen(): void {
        if (this.isClosed) throw closedError();
    }

    private ensureUnowned(targetId: string): void {
        const owner = this.registry.ownerOf(targetId);

        if (owner === this) {
            throw new RpcError(ErrorCode.alreadyClaimed, "The tab is already claimed by this session.");
        }

        if (owner) {
            throw new RpcError(ErrorCode.alreadyClaimed, "The tab is already used by another session.");
        }
    }

    private assertCurrent(targetId: string, tab: OwnedTab): void {
        this.ensureOpen();
        if (this.tabs.get(targetId) !== tab || tab.closing) throw tabGone();
    }

    private owned(targetId: string): OwnedTab {
        const tab = this.tabs.get(targetId);

        if (tab && !tab.closing) return tab;
        if (tab) throw new RpcError(ErrorCode.notFound, "The tab is being closed.");

        if (this.registry.ownerOf(targetId)) {
            throw new RpcError(ErrorCode.notOwned, "The tab belongs to another session.");
        }

        throw new RpcError(ErrorCode.notFound, "No such tab in this session.");
    }

    private forget(targetId: string): void {
        const tab = this.tabs.get(targetId);

        if (!tab) return;

        this.tabs.delete(targetId);
        this.registry.releaseOwner(targetId, this);
        for (const entry of tab.subscriptions.values()) entry.off();
        void tab.children?.then((children) => children.detachAll()).catch(() => undefined);
        void tab.attached?.then((session) => session.detach()).catch(() => undefined);
    }
}
