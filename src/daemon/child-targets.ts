import { z } from "zod";
import type { CdpClient, CdpSession } from "../cdp/index.js";
import {
    MAX_CHILD_ATTACH_DEPTH,
    MAX_CHILD_SESSIONS_PER_TAB,
    type ChildSessionHandle,
    type ChildSessionOptions,
    type ChildTargetInfo,
    type FrameChildSession,
} from "./browser-backend.js";
import { describeError, logDaemon } from "./log.js";

const targetInfoSchema = z.object({
    targetId: z.string().min(1),
    type    : z.string(),
    url     : z.string().optional(),
});

const attachedSchema = z.object({
    sessionId         : z.string().min(1),
    targetInfo        : targetInfoSchema,
    waitingForDebugger: z.boolean().optional(),
});

const detachedSchema = z.object({ sessionId: z.string().min(1) });

export interface ChildTargetsDeps {
    send(
        session: CdpSession,
        method : string,
        params : Record<string, unknown>,
    ): Promise<unknown>;
    adopt(sessionId: string, targetId: string): CdpSession;
    on(
        session: CdpSession,
        event  : string,
        handler: (params: unknown, sessionId?: string) => void,
    ): () => void;
    log(message: string): void;
}

export function cdpChildTargetsDeps(client: CdpClient): ChildTargetsDeps {
    return {
        send : (session, method, params) => session.send(method, params),
        adopt: (sessionId, targetId) => client.adoptSession(sessionId, targetId),
        on   : (session, event, handler) => session.on(event, handler),
        log  : (message) => logDaemon(message),
    };
}

interface KnownChild {
    child  : ChildTargetInfo;
    session: CdpSession;
    depth  : number;
}

function wrap(session: CdpSession, child: ChildTargetInfo): FrameChildSession {
    return {
        child,
        send  : (method, params, timeoutMs) => session.send(method, params, { timeoutMs }),
        on    : (event, handler) => session.on(event, (params) => handler(params)),
        detach: () => session.detach(),
    };
}

export class ChildTargets implements ChildSessionHandle {
    private readonly known = new Map<string, KnownChild>();
    private readonly unmatched = new Set<string>();
    private readonly listeners = new Map<string, Array<() => void>>();
    private closed = false;
    private dropped = 0;
    private readonly off: Array<() => void> = [];

    private constructor(
        private readonly options: ChildSessionOptions,
        private readonly deps   : ChildTargetsDeps,
    ) {}

    static async attach(
        peer   : CdpSession,
        options: ChildSessionOptions,
        deps   : ChildTargetsDeps,
    ): Promise<ChildTargets> {
        const handle = new ChildTargets(options, deps);

        handle.listen(peer, 0);
        await deps.send(peer, "Target.setAutoAttach", {
            autoAttach            : true,
            waitForDebuggerOnStart: true,
            flatten               : true,
            filter                : [{ type: "iframe", exclude: false }],
        });

        return handle;
    }

    children(): FrameChildSession[] {
        return [...this.known.values()].map((known) => wrap(known.session, known.child));
    }

    childCount(): number {
        return this.known.size;
    }

    droppedCount(): number {
        return this.dropped;
    }

    takeUnmatched(): FrameChildSession[] {
        const sessions: FrameChildSession[] = [];

        for (const sessionId of [...this.unmatched]) {
            const known = this.known.get(sessionId);

            if (known === undefined) {
                this.unmatched.delete(sessionId);
            } else {
                sessions.push(wrap(known.session, known.child));
            }
        }

        return sessions;
    }

    confirmMatched(sessionId: string): void {
        this.unmatched.delete(sessionId);
    }

    async detachAll(): Promise<void> {
        if (this.closed) return;

        this.closed = true;
        for (const off of this.off.splice(0)) off();

        const sessions = [...this.known.values()];

        this.known.clear();
        this.unmatched.clear();
        await Promise.all(sessions.map((known) => known.session.detach().catch(() => undefined)));
    }

    private listen(session: CdpSession, depth: number): void {
        const stop = [
            this.deps.on(session, "Target.attachedToTarget", (params, envelope) =>
                this.attached(session, depth, params, envelope)),
            this.deps.on(session, "Target.detachedFromTarget", (params) =>
                this.detached(params)),
        ];

        this.off.push(...stop);
        this.listeners.set(session.sessionId, stop);
    }

    private unlisten(sessionId: string): void {
        const stop = this.listeners.get(sessionId);

        if (stop === undefined) return;

        this.listeners.delete(sessionId);

        for (const off of stop) {
            off();
            this.off.splice(this.off.indexOf(off), 1);
        }
    }

    private attached(
        session : CdpSession,
        depth   : number,
        params  : unknown,
        envelope: string | undefined,
    ): void {
        if (this.closed) return;

        const parsed = attachedSchema.safeParse(params);

        if (!parsed.success || parsed.data.targetInfo.type !== "iframe") return;

        if (envelope !== undefined && envelope !== session.sessionId) return;

        this.adopt(
            session,
            depth + 1,
            parsed.data.sessionId,
            parsed.data.targetInfo.targetId,
            parsed.data.targetInfo.url,
            parsed.data.waitingForDebugger === true,
        );
    }

    private adopt(
        parent   : CdpSession,
        depth    : number,
        sessionId: string,
        targetId : string,
        url      : string | undefined,
        waiting  : boolean,
    ): void {
        if (this.closed || this.known.has(sessionId)) return;

        if (depth > MAX_CHILD_ATTACH_DEPTH || this.known.size >= MAX_CHILD_SESSIONS_PER_TAB) {
            this.dropped += 1;
            this.deps.log(
                `dropped an iframe session over the limit (${MAX_CHILD_SESSIONS_PER_TAB} per tab, depth ${MAX_CHILD_ATTACH_DEPTH})`,
            );
            void this.deps
                .send(parent, "Target.detachFromTarget", { sessionId })
                .catch((error: unknown) => this.deps.log(`could not detach an iframe: ${describeError(error)}`));

            return;
        }

        const child: ChildTargetInfo = {
            targetId,
            sessionId,
            frameId: undefined,
            url    : url ?? "",
        };
        const adopted = this.deps.adopt(sessionId, targetId);
        const known: KnownChild = { child, session: adopted, depth };

        this.known.set(sessionId, known);
        this.unmatched.add(sessionId);
        this.listen(adopted, depth);
        void this.start(adopted, known, waiting);
    }

    private async start(adopted: CdpSession, known: KnownChild, waiting: boolean): Promise<void> {
        await this.deps
            .send(adopted, "Target.setAutoAttach", {
                autoAttach            : true,
                waitForDebuggerOnStart: true,
                flatten               : true,
                filter                : [{ type: "iframe", exclude: false }],
            })
            .catch((error: unknown) => this.deps.log(`could not auto attach an iframe: ${describeError(error)}`));

        try {
            await this.options.onAttached?.(wrap(adopted, known.child));
        } catch (error) {
            this.deps.log(`a child attach handler threw: ${describeError(error)}`);
        }

        if (!waiting) return;

        await this.deps
            .send(adopted, "Runtime.runIfWaitingForDebugger", {})
            .catch((error: unknown) => this.deps.log(`could not resume an iframe: ${describeError(error)}`));
    }

    private detached(params: unknown): void {
        const parsed = detachedSchema.safeParse(params);

        if (!parsed.success) return;

        const known = this.known.get(parsed.data.sessionId);

        if (!known) return;

        this.known.delete(parsed.data.sessionId);
        this.unmatched.delete(parsed.data.sessionId);
        this.unlisten(parsed.data.sessionId);

        try {
            this.options.onDetached(known.child);
        } catch (error) {
            this.deps.log(`a child detach handler threw: ${describeError(error)}`);
        }
    }
}
