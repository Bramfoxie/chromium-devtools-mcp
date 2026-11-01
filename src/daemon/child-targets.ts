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
    clientOn(event: string, handler: (params: unknown, sessionId?: string) => void): () => void;
    log(message: string): void;
}

export function cdpChildTargetsDeps(client: CdpClient): ChildTargetsDeps {
    return {
        send    : (session, method, params) => session.send(method, params),
        adopt   : (sessionId, targetId) => client.adoptSession(sessionId, targetId),
        on      : (session, event, handler) => session.on(event, handler),
        clientOn: (event, handler) => client.on(event, handler),
        log     : (message) => logDaemon(message),
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
    // Child sessions arrive before the frame tree names them; matched by listFrames.
    private readonly unmatched = new Set<string>();
    private closed = false;
    private readonly off: Array<() => void> = [];

    private constructor(
        private readonly peer   : CdpSession,
        private readonly options: ChildSessionOptions,
        private readonly deps   : ChildTargetsDeps,
    ) {}

    static async attach(
        peer   : CdpSession,
        options: ChildSessionOptions,
        deps   : ChildTargetsDeps,
    ): Promise<ChildTargets> {
        const handle = new ChildTargets(peer, options, deps);

        handle.off.push(
            deps.on(peer, "Target.attachedToTarget", (params, sessionId) =>
                handle.attached(params, sessionId)),
            deps.clientOn("Target.detachedFromTarget", (params, sessionId) =>
                handle.detached(params, sessionId)),
        );
        await deps.send(peer, "Target.setAutoAttach", {
            autoAttach            : true,
            waitForDebuggerOnStart: false,
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

    takeUnmatched(): FrameChildSession[] {
        const sessions = [...this.unmatched]
            .flatMap((sessionId) => {
                const known = this.known.get(sessionId);

                return known === undefined ? [] : [known];
            })
            .map((known) => wrap(known.session, known.child));

        this.unmatched.clear();

        return sessions;
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

    private attached(params: unknown, envelopeSessionId: string | undefined): void {
        if (this.closed) return;

        const parsed = attachedSchema.safeParse(params);

        if (!parsed.success || parsed.data.targetInfo.type !== "iframe") return;

        const parent = envelopeSessionId === undefined
            ? undefined
            : envelopeSessionId === this.peer.sessionId
                ? { depth: 0 }
                : this.known.get(envelopeSessionId);

        if (parent === undefined) return;

        const depth = parent.depth + 1;

        if (depth > MAX_CHILD_ATTACH_DEPTH) return;

        this.adopt(
            parsed.data.sessionId,
            parsed.data.targetInfo.targetId,
            depth,
            parsed.data.targetInfo.url,
        );
    }

    private adopt(sessionId: string, targetId: string, depth: number, url?: string): void {
        if (this.closed || this.known.has(sessionId)) return;

        if (this.known.size >= MAX_CHILD_SESSIONS_PER_TAB) {
            this.deps.log(`dropped an iframe session over the ${MAX_CHILD_SESSIONS_PER_TAB} limit`);

            return;
        }

        const child: ChildTargetInfo = {
            targetId,
            sessionId,
            frameId: undefined,
            url    : url ?? "",
        };

        this.known.set(sessionId, { child, session: this.deps.adopt(sessionId, targetId), depth });
        this.unmatched.add(sessionId);
    }

    private detached(params: unknown, envelopeSessionId: string | undefined): void {
        const parsed = detachedSchema.safeParse(params);

        if (!parsed.success) return;

        const known = this.known.get(parsed.data.sessionId);

        if (!known) return;
        if (envelopeSessionId !== undefined && envelopeSessionId !== parsed.data.sessionId) return;

        this.known.delete(parsed.data.sessionId);
        this.unmatched.delete(parsed.data.sessionId);

        try {
            this.options.onDetached(known.child);
        } catch (error) {
            this.deps.log(`a child detach handler threw: ${describeError(error)}`);
        }
    }
}
