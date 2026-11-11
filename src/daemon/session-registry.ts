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

const MAX_REMEMBERED_DESTROYED = 512;

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
        const opening = this.openSession(key, emit, options);

        this.openingTasks.add(opening);
        void opening.then(
            () => this.openingTasks.delete(opening),
            () => this.openingTasks.delete(opening),
        );

        return opening;
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
                await this.backend.disposeContext(contextId).catch(() => undefined);
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

    async closeAll(): Promise<void> {
        this.shuttingDown = true;
        this.stopListening();
        this.opening.clear();
        const sessions = [...this.sessions.values()];

        this.sessions.clear();
        this.sessionIds.clear();
        for (const session of sessions) void this.closeSession(session);
        const [closed] = await Promise.all([
            Promise.allSettled(this.closing),
            Promise.allSettled(this.openingTasks),
        ]);
        const failure = closed.find((result) => result.status === "rejected");

        if (failure?.status === "rejected") throw failure.reason;
    }

    private closeSession(session: ClientSession): Promise<void> {
        const closing = session.close();

        this.closing.add(closing);
        void closing.then(
            () => this.closing.delete(closing),
            () => this.closing.delete(closing),
        );

        return closing;
    }

    private remember(targetId: string): void {
        this.destroyed.add(targetId);

        if (this.destroyed.size > MAX_REMEMBERED_DESTROYED) {
            const oldest = this.destroyed.values().next().value;

            if (oldest !== undefined) this.destroyed.delete(oldest);
        }
    }
}
