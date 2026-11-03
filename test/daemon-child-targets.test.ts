import { describe, expect, it, vi } from "vitest";
import type { CdpSession } from "../src/cdp/index.js";
import { CHILD_ATTACH_HANDLER_TIMEOUT_MS, CHILD_AUTO_ATTACH_TIMEOUT_MS, ChildTargets, type ChildTargetsDeps } from "../src/daemon/child-targets.js";
import { MAX_CHILD_ATTACH_DEPTH, MAX_CHILD_SESSIONS_PER_TAB } from "../src/daemon/browser-backend.js";

interface SentCall {
    session: string;
    method : string;
    params : Record<string, unknown>;
}

type HandlerMap = Map<string, Set<(params: unknown, sessionId?: string) => void>>;

function setup() {
    const sent: SentCall[] = [];
    const sessions = new Map<string, { handlers: HandlerMap }>();
    const detached: string[] = [];
    const log: string[] = [];
    const sessionOf = (session: CdpSession): { handlers: HandlerMap } => {
        let entry = sessions.get(session.sessionId);

        if (!entry) {
            entry = { handlers: new Map() };
            sessions.set(session.sessionId, entry);
        }

        return entry;
    };
    const peer = { sessionId: "peer-session" } as CdpSession;
    const deps: ChildTargetsDeps = {
        send: async (session, method, params) => {
            sent.push({ session: session.sessionId, method, params });

            return {};
        },
        adopt: (sessionId) => {
            const child = {
                sessionId,
                detach: async () => void detached.push(sessionId),
            } as unknown as CdpSession;

            sessionOf(child);

            return child;
        },
        on: (session, event, handler) => {
            const entry = sessionOf(session);
            let set = entry.handlers.get(event);

            if (!set) {
                set = new Set();
                entry.handlers.set(event, set);
            }

            set.add(handler);

            return () => void set.delete(handler);
        },
        log: (message) => void log.push(message),
    };
    const emit = (
        session  : CdpSession,
        event    : string,
        params   : unknown,
        envelope?: string,
    ) => {
        for (const handler of [...(sessionOf(session).handlers.get(event) ?? [])]) {
            handler(params, envelope);
        }
    };
    const childSession = (sessionId: string): CdpSession => {
        sessionOf({ sessionId } as CdpSession);

        return { sessionId } as CdpSession;
    };
    const attach = (
        targetId : string,
        sessionId: string,
        session  : CdpSession,
        type = "iframe",
        waitingForDebugger = false,
    ) =>
        emit(session, "Target.attachedToTarget", {
            sessionId,
            targetInfo: { targetId, type, url: `https://${targetId}.example/` },
            waitingForDebugger,
        }, session.sessionId);

    return { sent, detached, log, peer, deps, emit, attach, childSession };
}

describe("ChildTargets.attach", () => {
    it("enables auto attach for iframe targets only", async () => {
        const { sent, peer, deps } = setup();

        await ChildTargets.attach(peer, { onDetached: () => undefined }, deps);
        expect(sent).toEqual([
            {
                session: "peer-session",
                method : "Target.setAutoAttach",
                params : {
                    autoAttach            : true,
                    waitForDebuggerOnStart: true,
                    flatten               : true,
                    filter                : [{ type: "iframe", exclude: false }],
                },
            },
        ]);
    });

    it("lets the attach handler run before a paused child resumes", async () => {
        const { sent, peer, deps, attach } = setup();
        const order: string[] = [];
        const handle = await ChildTargets.attach(
            peer,
            {
                onDetached: () => undefined,
                onAttached: async (child) => {
                    order.push(`attached ${child.child.sessionId}`);
                },
            },
            deps,
        );

        attach("child1", "child-session-1", peer, "iframe", true);
        await vi.waitFor(() =>
            expect(sent.map((call) => call.method)).toContain("Runtime.runIfWaitingForDebugger"));

        expect(order).toEqual(["attached child-session-1"]);
        expect(sent.filter((call) => call.session === "child-session-1").map((call) => call.method))
            .toEqual(["Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]);
        expect(handle.children().length).toBe(1);
    });

    it("resumes a paused child even when the attach handler fails", async () => {
        const { sent, peer, deps, attach } = setup();

        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        await ChildTargets.attach(
            peer,
            {
                onDetached: () => undefined,
                onAttached: async () => {
                    throw new Error("boom");
                },
            },
            deps,
        );

        attach("child1", "child-session-1", peer, "iframe", true);
        await vi.waitFor(() =>
            expect(sent.map((call) => call.method)).toContain("Runtime.runIfWaitingForDebugger"));
    });

    it("resumes a paused child within the bound when the child hangs", async () => {
        vi.useFakeTimers();

        try {
            const { sent, peer, deps, attach } = setup();
            const hanging: ChildTargetsDeps = {
                ...deps,
                send: (session, method, params, timeoutMs) => {
                    if (session === peer || method === "Runtime.runIfWaitingForDebugger") {
                        return deps.send(session, method, params, timeoutMs);
                    }

                    return new Promise((_resolve, reject) => {
                        setTimeout(() => reject(new Error("timed out")), timeoutMs ?? 30_000);
                    });
                },
            };

            vi.spyOn(process.stderr, "write").mockImplementation(() => true);
            const attaching = ChildTargets.attach(
                peer,
                { onDetached: () => undefined, onAttached: () => new Promise(() => undefined) },
                hanging,
            );

            await vi.advanceTimersByTimeAsync(0);
            await attaching;
            attach("child1", "child-session-1", peer, "iframe", true);
            await vi.advanceTimersByTimeAsync(
                CHILD_AUTO_ATTACH_TIMEOUT_MS + CHILD_ATTACH_HANDLER_TIMEOUT_MS,
            );

            expect(sent.map((call) => call.method)).toContain("Runtime.runIfWaitingForDebugger");
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not resume a child that was not paused", async () => {
        const { sent, peer, deps, attach } = setup();
        let attached = 0;

        await ChildTargets.attach(
            peer,
            { onDetached: () => undefined, onAttached: async () => void (attached += 1) },
            deps,
        );
        attach("child1", "child-session-1", peer);
        await vi.waitFor(() => expect(attached).toBe(1));

        expect(sent.map((call) => call.method)).not.toContain("Runtime.runIfWaitingForDebugger");
    });

    it("tracks iframe sessions of the tab and ignores other envelopes", async () => {
        const { peer, deps, attach, childSession } = setup();
        const handle = await ChildTargets.attach(peer, { onDetached: () => undefined }, deps);

        attach("child1", "child-session-1", peer);
        attach("stranger", "stranger-session", childSession("other-session"));
        attach("page", "page-session", peer, "page");

        expect(handle.children().length).toBe(1);
        expect(handle.children().map((child) => child.child)).toEqual([
            {
                targetId : "child1",
                sessionId: "child-session-1",
                frameId  : undefined,
                url      : "https://child1.example/",
            },
        ]);
    });

    it("tracks nested iframe sessions up to the depth limit", async () => {
        const { peer, deps, attach, childSession } = setup();
        const handle = await ChildTargets.attach(peer, { onDetached: () => undefined }, deps);

        let session = peer;

        for (let depth = 1; depth <= MAX_CHILD_ATTACH_DEPTH + 1; depth += 1) {
            attach(`child${depth}`, `session${depth}`, session);
            session = childSession(`session${depth}`);
        }

        expect(handle.children().length).toBe(MAX_CHILD_ATTACH_DEPTH);
        expect(handle.droppedCount()).toBe(1);
    });

    it("auto attaches on adopted child sessions", async () => {
        const { sent, peer, deps, attach, childSession } = setup();
        const handle = await ChildTargets.attach(peer, { onDetached: () => undefined }, deps);

        attach("child1", "child-session-1", peer);
        attach("grandchild", "grandchild-session", childSession("child-session-1"));

        expect(handle.children().length).toBe(2);
        const autoAttached = sent
            .filter((call) => call.method === "Target.setAutoAttach")
            .map((call) => call.session)
            .sort();

        expect(autoAttached).toEqual(["child-session-1", "grandchild-session", "peer-session"]);
    });

    it("detaches sessions over the per tab limit and reports them", async () => {
        const { peer, deps, attach, sent, log, childSession } = setup();
        const handle = await ChildTargets.attach(peer, { onDetached: () => undefined }, deps);

        for (let index = 0; index < MAX_CHILD_SESSIONS_PER_TAB + 1; index += 1) {
            attach(`child${index}`, `session${index}`, peer);
        }

        expect(handle.children().length).toBe(MAX_CHILD_SESSIONS_PER_TAB);
        expect(handle.droppedCount()).toBe(1);
        expect(log.join("\n")).toContain(String(MAX_CHILD_SESSIONS_PER_TAB));
        const detach = sent.find((call) => call.method === "Target.detachFromTarget");

        expect(detach).toMatchObject({ session: "peer-session" });
        attach("nested", "nested-session", childSession("session0"));
        expect(handle.droppedCount()).toBe(2);
    });

    it("forgets a child on the parent envelope detach and tells the owner", async () => {
        const { peer, deps, attach, emit } = setup();
        const seen: string[] = [];
        const handle = await ChildTargets.attach(
            peer,
            { onDetached: (child) => void seen.push(child.sessionId) },
            deps,
        );

        attach("child1", "child-session-1", peer);
        emit(peer, "Target.detachedFromTarget", { sessionId: "child-session-1" }, "peer-session");
        emit(peer, "Target.detachedFromTarget", { sessionId: "unknown" }, "peer-session");

        expect(handle.children().length).toBe(0);
        expect(seen).toEqual(["child-session-1"]);
    });

    it("does not keep listener stops of detached children", async () => {
        const { peer, deps, attach, emit } = setup();
        const stops: number[] = [];
        const counting: ChildTargetsDeps = {
            ...deps,
            on: (session, event, handler) => {
                const stop = deps.on(session, event, handler);
                const index = stops.push(0) - 1;

                return () => {
                    stops[index] = (stops[index] ?? 0) + 1;
                    stop();
                };
            },
        };
        const handle = await ChildTargets.attach(peer, { onDetached: () => undefined }, counting);

        attach("child1", "child-session-1", peer);
        emit(peer, "Target.detachedFromTarget", { sessionId: "child-session-1" }, "peer-session");
        await handle.detachAll();

        expect(Math.max(...stops)).toBe(1);
    });

    it("forgets a nested child on its parent session detach", async () => {
        const { peer, deps, attach, emit, childSession } = setup();
        const seen: string[] = [];
        const handle = await ChildTargets.attach(
            peer,
            { onDetached: (child) => void seen.push(child.sessionId) },
            deps,
        );

        attach("child1", "child-session-1", peer);
        attach("grandchild", "grandchild-session", childSession("child-session-1"));
        emit(
            childSession("child-session-1"),
            "Target.detachedFromTarget",
            { sessionId: "grandchild-session" },
            "child-session-1",
        );

        expect(seen).toEqual(["grandchild-session"]);
        expect(handle.children().length).toBe(1);
    });

    it("hands out unmatched children until they match and retries failures", async () => {
        const { peer, deps, attach } = setup();
        const handle = await ChildTargets.attach(peer, { onDetached: () => undefined }, deps);

        attach("child1", "child-session-1", peer);

        expect(handle.takeUnmatched().map((child) => child.child.sessionId)).toEqual([
            "child-session-1",
        ]);
        expect(handle.takeUnmatched().map((child) => child.child.sessionId)).toEqual([
            "child-session-1",
        ]);
        handle.confirmMatched("child-session-1");
        expect(handle.takeUnmatched()).toEqual([]);
        expect(handle.children().length).toBe(1);
    });

    it("detaches every child and stops listening on detachAll", async () => {
        const { peer, deps, attach, detached, emit } = setup();
        const handle = await ChildTargets.attach(peer, { onDetached: () => undefined }, deps);

        attach("child1", "child-session-1", peer);
        attach("child2", "child-session-2", peer);
        await handle.detachAll();
        attach("child3", "child-session-3", peer);
        emit(peer, "Target.detachedFromTarget", { sessionId: "child-session-3" }, "peer-session");

        expect(detached.sort()).toEqual(["child-session-1", "child-session-2"]);
        expect(handle.children().length).toBe(0);
        expect(handle.children()).toEqual([]);
        await handle.detachAll();
        expect(detached).toHaveLength(2);
    });

    it("logs a throwing detach handler instead of breaking", async () => {
        const { peer, deps, attach, emit, log } = setup();

        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const handle = await ChildTargets.attach(
            peer,
            {
                onDetached: () => {
                    throw new Error("boom");
                },
            },
            deps,
        );

        attach("child1", "child-session-1", peer);
        emit(peer, "Target.detachedFromTarget", { sessionId: "child-session-1" }, "peer-session");

        expect(handle.children().length).toBe(0);
        expect(log.join("\n")).toContain("child detach handler threw");
    });
});
