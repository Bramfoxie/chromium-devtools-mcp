import type { BrowserBackend } from "./browser-backend.js";
import {
    ClientSession,
    type Emit,
    type Ownership,
    type SessionOptions,
} from "./client-session.js";
import type { SessionSafety } from "./cdp-safety.js";
import { RpcError } from "./errors.js";
import { PermissionLedger } from "./permissions.js";
import { TraceLock } from "./trace-lock.js";
import { ErrorCode } from "./protocol.js";
import type { SessionSummary } from "./wire.js";
import { closedError, translate } from "./rpc-errors.js";
import { logDaemon } from "../util/log.js";

const MAX_REMEMBERED_DESTROYED = 512;

class InterruptedContextCleanupError extends Error {
    constructor() {
        super("Could not dispose an interrupted browser context.");
    }
}

function deferred<T>(): {
    promise: Promise<T>;
    fulfill: (value: T | PromiseLike<T>) => void;
    fail   : (error: unknown) => void;
} {
    let fulfill: (value: T | PromiseLike<T>) => void = () => undefined;
    let fail: (error: unknown) => void = () => undefined;
    const promise = new Promise<T>((resolve, reject) => {
        fulfill = resolve;
        fail = reject;
    });

    return { promise, fulfill, fail };
}

function trackOperation<T>(pending: Set<Promise<T>>, run: () => Promise<T>): Promise<T> {
    const { promise: tracked, fulfill, fail } = deferred<T>();

    pending.add(tracked);
    void tracked.then(
        () => pending.delete(tracked),
        () => pending.delete(tracked),
    );

    try {
        void run().then(fulfill, fail);
    } catch (error) {
        fail(error);
    }

    return tracked;
}

export interface SessionOpenOptions {
    isolated  : boolean;
    clientName: string;
    safety?   : SessionSafety;
}

export class SessionRegistry<K> implements Ownership {
    private readonly sessions = new Map<K, ClientSession>();
    private readonly owners = new Map<string, ClientSession>();
    private readonly opening = new Map<K, symbol>();
    private readonly openingTasks = new Set<Promise<ClientSession>>();
    private readonly sessionIds = new Map<ClientSession, string>();
    private readonly closing = new Set<Promise<void>>();
    private nextSessionId = 1;
    private readonly destroyed = new Set<string>();
    private readonly stopListening: () => void;
    private shuttingDown = false;
    private shutdownPromise       : Promise<void> | undefined;
    private readonly permissions  : PermissionLedger;
    private readonly traceLock = new TraceLock();

    constructor(
        private readonly backend: BrowserBackend,
        private readonly options: SessionOptions,
    ) {
        this.permissions = new PermissionLedger(backend);
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

    open(key: K, emit: Emit, options: SessionOpenOptions): Promise<ClientSession> {
        return trackOperation(this.openingTasks, () => this.openSession(key, emit, options));
    }

    private async openSession(
        key: K, emit: Emit, options: SessionOpenOptions,
    ): Promise<ClientSession> {
        if (this.shuttingDown) throw closedError();

        if (this.sessions.has(key) || this.opening.has(key)) {
            throw new RpcError(ErrorCode.badRequest, "A session is already open on this connection.");
        }

        const ticket = Symbol("open");

        this.opening.set(key, ticket);
        let contextId: string | undefined;

        try {
            contextId = options.isolated ? await this.backend.createContext() : undefined;
        } catch (error) {
            if (this.opening.get(key) === ticket) this.opening.delete(key);

            throw translate(error);
        }

        if (this.opening.get(key) !== ticket) {
            if (contextId !== undefined) {
                try {
                    await this.backend.disposeContext(contextId);
                } catch {
                    try {
                        logDaemon("could not dispose an interrupted browser context");
                    } catch {
                    }

                    throw new InterruptedContextCleanupError();
                }
            }

            throw closedError();
        }

        this.opening.delete(key);
        const session = new ClientSession({
            backend    : this.backend,
            registry   : this,
            emit,
            options    : this.options,
            contextId,
            clientName : options.clientName,
            safety     : options.safety,
            permissions: this.permissions,
            traceLock  : this.traceLock,
        });

        this.sessions.set(key, session);
        this.sessionIds.set(session, `session${this.nextSessionId++}`);

        return session;
    }

    listSessions(caller: K): SessionSummary[] {
        const callerSession = this.sessions.get(caller);
        const summaries: SessionSummary[] = [];

        for (const session of this.sessions.values()) {
            if (session.closed) continue;

            const sessionId = this.sessionIds.get(session);

            if (sessionId === undefined) continue;

            summaries.push({
                sessionId,
                clientName: session.clientName,
                isolated  : session.isolated,
                tabs      : session.tabCount,
                own       : session === callerSession,
            });
        }

        return summaries;
    }

    async close(key: K): Promise<void> {
        this.opening.delete(key);
        const session = this.sessions.get(key);

        if (!session) return;

        this.sessions.delete(key);
        this.sessionIds.delete(session);
        await this.closeSession(session);
    }

    closeAll(): Promise<void> {
        if (this.shutdownPromise) return this.shutdownPromise;

        const { promise, fulfill, fail } = deferred<void>();

        this.shutdownPromise = promise;
        void this.shutdownAll().then(fulfill, fail);

        return promise;
    }

    private async shutdownAll(): Promise<void> {
        this.shuttingDown = true;
        this.stopListening();
        this.opening.clear();
        const sessions = [...this.sessions.values()];

        this.sessions.clear();
        this.sessionIds.clear();
        for (const session of sessions) void this.closeSession(session);
        const [closed, opened] = await Promise.all([
            Promise.allSettled(this.closing),
            Promise.allSettled(this.openingTasks),
        ]);
        const failure = closed.find((result) => result.status === "rejected");
        const cleanupFailure = opened.find((result) =>
            result.status === "rejected" && result.reason instanceof InterruptedContextCleanupError);

        if (failure?.status === "rejected") throw failure.reason;
        if (cleanupFailure?.status === "rejected") throw cleanupFailure.reason;
    }

    private closeSession(session: ClientSession): Promise<void> {
        return trackOperation(this.closing, () => session.close());
    }

    private remember(targetId: string): void {
        this.destroyed.add(targetId);

        if (this.destroyed.size > MAX_REMEMBERED_DESTROYED) {
            const oldest = this.destroyed.values().next().value;

            if (oldest !== undefined) this.destroyed.delete(oldest);
        }
    }
}
