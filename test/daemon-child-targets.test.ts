import { describe, expect, it, vi } from "vitest";
import type { CdpSession } from "../src/cdp/index.js";
import {
    ChildTargets,
    MAX_CHILD_ATTACH_DEPTH,
    MAX_CHILD_SESSIONS_PER_TAB,
    type ChildTargetsDeps,
} from "../src/daemon/index.js";

interface SentCall {
    method: string;
    params: Record<string, unknown>;
}

function setup() {
    const sent: SentCall[] = [];
    const listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>();
    const detached: string[] = [];
    const log: string[] = [];
    const peer = { sessionId: "peer-session" } as CdpSession;
    const deps: ChildTargetsDeps = {
        send: async (_session, method, params) => {
            sent.push({ method, params });

            return {};
        },
        adopt: (sessionId) =>
            ({
                sessionId,
                detach: async () => void detached.push(sessionId),
            } as unknown as CdpSession),
        on      : (_session, event, handler) => deps.clientOn(event, handler),
        clientOn: (event, handler) => {
            let set = listeners.get(event);

            if (!set) {
                set = new Set();
                listeners.set(event, set);
            }

            set.add(handler);

            return () => void set.delete(handler);
        },
        log: (message) => void log.push(message),
    };
    const emit = (event: string, params: unknown, sessionId?: string) => {
        for (const handler of [...(listeners.get(event) ?? [])]) handler(params, sessionId);
    };
    const attach = (targetId: string, sessionId: string, envelope?: string, type = "iframe") =>
        emit("Target.attachedToTarget", {
            sessionId,
            targetInfo: { targetId, type, url: `https://${targetId}.example/` },
        }, envelope);

    return { sent, listeners, detached, log, peer, deps, emit, attach };
}

describe("ChildTargets.attach", () => {
    it("enables auto attach for iframe targets only", async () => {
        const { sent, peer, deps } = setup();

        await ChildTargets.attach(peer, { onDetached: () => undefined }, deps);
        expect(sent).toEqual([
            {
                method: "Target.setAutoAttach",
                params: {
                    autoAttach            : true,
                    waitForDebuggerOnStart: false,
                    flatten               : true,
                    filter                : [{ type: "iframe", exclude: false }],
                },
            },
        ]);
    });

    it("tracks iframe sessions of the tab and ignores other envelopes", async () => {
        const { peer, deps, attach } = setup();
        const handle = await ChildTargets.attach(peer, { onDetached: () => undefined }, deps);

        attach("child1", "child-session-1", "peer-session");
        attach("stranger", "stranger-session", "other-session");
        attach("page", "page-session", "peer-session", "page");

        expect(handle.childCount()).toBe(1);
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
        const { peer, deps, attach } = setup();
        const handle = await ChildTargets.attach(peer, { onDetached: () => undefined }, deps);

        let parent = "peer-session";

        for (let depth = 1; depth <= MAX_CHILD_ATTACH_DEPTH + 1; depth += 1) {
            attach(`child${depth}`, `session${depth}`, parent);
            parent = `session${depth}`;
        }

        expect(handle.childCount()).toBe(MAX_CHILD_ATTACH_DEPTH);
    });

    it("drops sessions over the per tab limit and logs it", async () => {
        const { peer, deps, attach, log } = setup();
        const handle = await ChildTargets.attach(peer, { onDetached: () => undefined }, deps);

        for (let index = 0; index < MAX_CHILD_SESSIONS_PER_TAB + 1; index += 1) {
            attach(`child${index}`, `session${index}`, "peer-session");
        }

        expect(handle.childCount()).toBe(MAX_CHILD_SESSIONS_PER_TAB);
        expect(log.join("\n")).toContain(String(MAX_CHILD_SESSIONS_PER_TAB));
    });

    it("forgets a child on detach and tells the owner", async () => {
        const { peer, deps, attach, emit } = setup();
        const seen: string[] = [];
        const handle = await ChildTargets.attach(
            peer,
            { onDetached: (child) => void seen.push(child.sessionId) },
            deps,
        );

        attach("child1", "child-session-1", "peer-session");
        emit("Target.detachedFromTarget", { sessionId: "child-session-1" }, "child-session-1");
        emit("Target.detachedFromTarget", { sessionId: "unknown" }, "unknown");

        expect(handle.childCount()).toBe(0);
        expect(seen).toEqual(["child-session-1"]);
    });

    it("hands out unmatched children once for frame matching", async () => {
        const { peer, deps, attach } = setup();
        const handle = await ChildTargets.attach(peer, { onDetached: () => undefined }, deps);

        attach("child1", "child-session-1", "peer-session");

        expect(handle.takeUnmatched().map((child) => child.child.sessionId)).toEqual([
            "child-session-1",
        ]);
        expect(handle.takeUnmatched()).toEqual([]);
        expect(handle.childCount()).toBe(1);
    });

    it("detaches every child and stops listening on detachAll", async () => {
        const { peer, deps, attach, detached, listeners } = setup();
        const handle = await ChildTargets.attach(peer, { onDetached: () => undefined }, deps);

        attach("child1", "child-session-1", "peer-session");
        attach("child2", "child-session-2", "peer-session");
        await handle.detachAll();
        attach("child3", "child-session-3", "peer-session");

        expect(detached.sort()).toEqual(["child-session-1", "child-session-2"]);
        expect(handle.childCount()).toBe(0);
        expect(handle.children()).toEqual([]);
        expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
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

        attach("child1", "child-session-1", "peer-session");
        emit("Target.detachedFromTarget", { sessionId: "child-session-1" }, "child-session-1");

        expect(handle.childCount()).toBe(0);
        expect(log.join("\n")).toContain("child detach handler threw");
    });
});
