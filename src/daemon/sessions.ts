import { CdpClosedError, CdpProtocolError, CdpTimeoutError } from "../cdp/errors.js";
import type { BackendSession, BrowserBackend, TargetInfo } from "./browser-backend.js";
import { RpcError } from "./errors.js";
import { describeError, logDaemon } from "./log.js";
import { checkCall, checkEvent } from "./method-policy.js";
import { ErrorCode } from "./protocol.js";

const DETACH_GRACE_MS = 2000;
const MAX_REMEMBERED_DESTROYED = 512;

export interface SessionOptions {
    allowFocus: boolean;
}

export interface TabInfo {
    targetId: string;
    url     : string;
    title   : string;
    owned   : boolean;
    created : boolean;
}

export type TabScope = "owned" | "available";

export type Emit = (event: string, params?: unknown) => void;

interface OwnedTab {
    created      : boolean;
    closing      : boolean;
    attached?    : Promise<BackendSession>;
    subscriptions: Map<string, () => void>;
}

interface Ownership {
    ownerOf(targetId: string): ClientSession | undefined;
    setOwner(targetId: string, session: ClientSession): void;
    releaseOwner(targetId: string, session: ClientSession): void;
    wasDestroyed(targetId: string): boolean;
}

function closedError(): RpcError {
    return new RpcError(ErrorCode.sessionClosed, "The session is closed.");
}

function tabGone(): RpcError {
    return new RpcError(ErrorCode.notFound, "The tab was closed.");
}

function translate(error: unknown): unknown {
    if (error instanceof CdpProtocolError) return new RpcError(ErrorCode.cdpError, error.message);
    if (error instanceof CdpTimeoutError) return new RpcError(ErrorCode.cdpTimeout, error.message);

    if (error instanceof CdpClosedError) {
        return new RpcError(ErrorCode.browserClosed, error.message);
    }

    return error;
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
    private isClosed = false;

    constructor(
        private readonly backend : BrowserBackend,
        private readonly registry: Ownership,
        private readonly emit    : Emit,
        private readonly options : SessionOptions,
        readonly contextId       : string | undefined,
    ) {}

    get isolated(): boolean {
        return this.contextId !== undefined;
    }

    get closed(): boolean {
        return this.isClosed;
    }

    async createTab(url: string): Promise<string> {
        this.ensureOpen();
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
        this.tabs.set(targetId, { created: true, closing: false, subscriptions: new Map() });

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
        this.tabs.set(targetId, { created: false, closing: false, subscriptions: new Map() });
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

    async send(
        targetId  : string,
        method    : string,
        params    : Record<string, unknown> | undefined,
        timeoutMs?: number,
    ): Promise<unknown> {
        this.ensureOpen();
        const tab = this.owned(targetId);

        const checked = checkCall(method, params, this.options);

        try {
            const session = await this.attached(targetId, tab);

            this.assertCurrent(targetId, tab);

            return await session.send(method, checked, timeoutMs);
        } catch (error) {
            throw translate(error);
        }
    }

    async subscribe(targetId: string, event: string): Promise<void> {
        this.ensureOpen();
        const tab = this.owned(targetId);

        checkEvent(event);
        if (tab.subscriptions.has(event)) return;

        try {
            const session = await this.attached(targetId, tab);

            this.assertCurrent(targetId, tab);
            if (tab.subscriptions.has(event)) return;

            tab.subscriptions.set(
                event,
                session.on(event, (params) => this.emit("cdp.event", { targetId, event, params })),
            );
        } catch (error) {
            throw translate(error);
        }
    }

    unsubscribe(targetId: string, event: string): void {
        this.ensureOpen();
        const tab = this.owned(targetId);

        tab.subscriptions.get(event)?.();
        tab.subscriptions.delete(event);
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

        for (const [targetId, tab] of entries) {
            for (const off of tab.subscriptions.values()) off();

            if (!tab.created && this.contextId === undefined) {
                this.registry.releaseOwner(targetId, this);
            }
        }

        const detaches = Promise.all(
            entries.map(async ([, tab]) => {
                const session = await tab.attached?.catch(() => undefined);

                await session?.detach().catch(() => undefined);
            }),
        );

        try {
            await Promise.all([this.dispose(entries), within(detaches, DETACH_GRACE_MS)]);
        } finally {
            for (const [targetId] of entries) this.registry.releaseOwner(targetId, this);
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

    private attached(targetId: string, tab: OwnedTab): Promise<BackendSession> {
        if (!tab.attached) {
            const attaching = this.backend.attach(targetId);

            tab.attached = attaching;
            attaching.catch(() => {
                if (tab.attached === attaching) tab.attached = undefined;
            });
        }

        return tab.attached;
    }

    private forget(targetId: string): void {
        const tab = this.tabs.get(targetId);

        if (!tab) return;

        this.tabs.delete(targetId);
        this.registry.releaseOwner(targetId, this);
        for (const off of tab.subscriptions.values()) off();
        void tab.attached?.then((session) => session.detach()).catch(() => undefined);
    }
}

export class SessionRegistry<K> implements Ownership {
    private readonly sessions = new Map<K, ClientSession>();
    private readonly owners = new Map<string, ClientSession>();
    private readonly opening = new Map<K, symbol>();
    private readonly destroyed = new Set<string>();
    private readonly stopListening: () => void;
    private shuttingDown = false;

    constructor(
        private readonly backend: BrowserBackend,
        private readonly options: SessionOptions,
    ) {
        this.stopListening = backend.onTargetDestroyed((targetId) => {
            this.remember(targetId);
            this.owners.get(targetId)?.handleTargetDestroyed(targetId);
        });
    }

    get(key: K): ClientSession | undefined {
        return this.sessions.get(key);
    }

    ownerOf(targetId: string): ClientSession | undefined {
        return this.owners.get(targetId);
    }

    setOwner(targetId: string, session: ClientSession): void {
        this.owners.set(targetId, session);
    }

    releaseOwner(targetId: string, session: ClientSession): void {
        if (this.owners.get(targetId) === session) this.owners.delete(targetId);
    }

    wasDestroyed(targetId: string): boolean {
        return this.destroyed.has(targetId);
    }

    async open(key: K, emit: Emit, isolated: boolean): Promise<ClientSession> {
        if (this.shuttingDown) throw closedError();

        if (this.sessions.has(key) || this.opening.has(key)) {
            throw new RpcError(ErrorCode.badRequest, "A session is already open on this connection.");
        }

        const ticket = Symbol("open");

        this.opening.set(key, ticket);
        let contextId: string | undefined;

        try {
            contextId = isolated ? await this.backend.createContext() : undefined;
        } catch (error) {
            if (this.opening.get(key) === ticket) this.opening.delete(key);

            throw translate(error);
        }

        if (this.opening.get(key) !== ticket) {
            if (contextId !== undefined) {
                await this.backend.disposeContext(contextId).catch(() => undefined);
            }

            throw closedError();
        }

        this.opening.delete(key);
        const session = new ClientSession(this.backend, this, emit, this.options, contextId);

        this.sessions.set(key, session);

        return session;
    }

    async close(key: K): Promise<void> {
        this.opening.delete(key);
        const session = this.sessions.get(key);

        if (!session) return;

        this.sessions.delete(key);
        await session.close();
    }

    async closeAll(): Promise<void> {
        this.shuttingDown = true;
        this.stopListening();
        this.opening.clear();
        const sessions = [...this.sessions.values()];

        this.sessions.clear();
        await Promise.all(sessions.map((session) => session.close()));
    }

    private remember(targetId: string): void {
        this.destroyed.add(targetId);

        if (this.destroyed.size > MAX_REMEMBERED_DESTROYED) {
            const oldest = this.destroyed.values().next().value;

            if (oldest !== undefined) this.destroyed.delete(oldest);
        }
    }
}
