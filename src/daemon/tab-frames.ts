import type { ChildSync } from "./child-sync.js";
import { frameSummaries, type FrameSummary } from "./frames.js";
import type {
    BackendSession,
    BrowserBackend,
    ChildSessionHandle,
    FrameChildSession,
} from "./browser-backend.js";
import { RpcError } from "./errors.js";
import { describeError, logDaemon } from "../util/log.js";
import { ErrorCode } from "./protocol.js";
import type { Emit } from "./client-session.js";

const CHILD_COMMAND_TIMEOUT_MS = 5000;
const FRAME_TREE_TIMEOUT_MS = 10_000;

export interface FrameEntry {
    summary : FrameSummary;
    session?: FrameChildSession;
    remote? : boolean;
}

export interface Subscription {
    count  : number;
    ready  : Promise<void>;
    off    : () => void;
    mirror?: (child: FrameChildSession) => void;
    mirrors: Map<string, () => void>;
}

export interface OwnedTab {
    created      : boolean;
    closing      : boolean;
    attached?    : Promise<BackendSession>;
    children?    : Promise<ChildSessionHandle>;
    frames       : Map<string, FrameEntry>;
    subscriptions: Map<string, Subscription>;
    sync         : ChildSync;
}

function unknownFrame(): RpcError {
    return new RpcError(ErrorCode.notFound, "No such frame in this tab.");
}

export class TabFrames {
    constructor(
        private readonly backend      : BrowserBackend,
        private readonly emit         : Emit,
        private readonly assertCurrent: (targetId: string, tab: OwnedTab) => void,
    ) {}

    async list(targetId: string, tab: OwnedTab): Promise<FrameSummary[]> {
        const session = await this.attached(targetId, tab);

        this.assertCurrent(targetId, tab);
        const tree = await session.send("Page.getFrameTree", undefined, FRAME_TREE_TIMEOUT_MS);
        const children = await this.childrenOf(targetId, tab).catch(() => undefined);

        this.assertCurrent(targetId, tab);

        const live = new Set(
            children?.children().map((child) => child.child.sessionId) ?? [],
        );

        for (const [frameId, entry] of tab.frames) {
            if (entry.session !== undefined && !live.has(entry.session.child.sessionId)) {
                if (entry.remote === true) tab.frames.delete(frameId);
                else tab.frames.set(frameId, { summary: entry.summary });

                this.unsubscribeAll(tab, frameId);
            }
        }

        const summaries = frameSummaries(tree, (frameId) =>
            tab.frames.get(frameId)?.session !== undefined);

        this.syncFrames(tab, summaries);
        await this.matchChildren(tab, children?.children(), children);
        const truncated = (children?.droppedCount() ?? 0) > 0;
        const remote = [...tab.frames.values()]
            .filter((entry) => entry.remote === true)
            .map((entry) => entry.summary);

        return [...summaries, ...remote].map((summary) => ({
            ...summary,
            isolated: tab.frames.get(summary.frameId)?.session !== undefined,
            truncated,
        }));
    }

    attached(targetId: string, tab: OwnedTab): Promise<BackendSession> {
        if (!tab.attached) {
            const attaching = this.backend.attach(targetId);

            tab.attached = attaching;
            attaching.catch(() => {
                if (tab.attached === attaching) tab.attached = undefined;
            });
        }

        return tab.attached;
    }

    childrenOf(targetId: string, tab: OwnedTab): Promise<ChildSessionHandle> {
        if (!tab.children) {
            const attaching = (async () => {
                const session = await this.attached(targetId, tab);

                return this.backend.attachChildren(session, {
                    onDetached: (child) => {
                        tab.sync.release(child.sessionId);

                        for (const subscription of tab.subscriptions.values()) {
                            subscription.mirrors.get(child.sessionId)?.();
                            subscription.mirrors.delete(child.sessionId);
                        }

                        for (const [frameId, entry] of tab.frames) {
                            if (entry.session?.child.sessionId !== child.sessionId) continue;

                            if (entry.remote === true) tab.frames.delete(frameId);
                            else tab.frames.set(frameId, { summary: entry.summary });

                            this.unsubscribeAll(tab, frameId);
                        }
                    },
                    onAttached: (child) => this.initChild(targetId, tab, child),
                });
            })();

            tab.children = attaching;
            attaching.catch(() => {
                if (tab.children === attaching) tab.children = undefined;
            });
        }

        return tab.children;
    }

    async sessionFor(
        targetId: string,
        tab     : OwnedTab,
        frameId : string | undefined,
    ): Promise<BackendSession> {
        if (frameId === undefined) return this.attached(targetId, tab);

        const children = await this.childrenOf(targetId, tab);
        const entry = tab.frames.get(frameId);

        if (entry?.session === undefined) {
            await this.matchChildren(tab, children.takeUnmatched(), children);
        }

        const matched = tab.frames.get(frameId);

        if (matched?.session === undefined) throw unknownFrame();

        return matched.session;
    }

    private syncFrames(tab: OwnedTab, summaries: FrameSummary[]): void {
        const seen = new Set(summaries.map((summary) => summary.frameId));

        for (const frameId of [...tab.frames.keys()]) {
            if (!seen.has(frameId)) tab.frames.delete(frameId);
        }

        for (const summary of summaries) {
            const entry = tab.frames.get(summary.frameId);

            tab.frames.set(summary.frameId, { summary, session: entry?.session });
        }
    }

    private async matchChildren(
        tab     : OwnedTab,
        sessions: FrameChildSession[] | undefined,
        children: ChildSessionHandle | undefined,
    ): Promise<void> {
        if (sessions === undefined || children === undefined) return;

        const trees = await Promise.all(sessions.map((child) =>
            child.send("Page.getFrameTree", undefined, CHILD_COMMAND_TIMEOUT_MS).catch(
                () => undefined,
            )));
        const live = new Set(children.children().map((child) => child.child.sessionId));

        for (const [index, child] of sessions.entries()) {
            if (!live.has(child.child.sessionId)) continue;

            const tree = frameSummaries(trees[index], () => true);
            const root = tree[0];

            if (root === undefined) continue;

            child.child.frameId = root.frameId;

            for (const summary of tree) {
                const entry = tab.frames.get(summary.frameId);

                if (entry === undefined) {
                    tab.frames.set(summary.frameId, { summary, session: child, remote: true });
                } else if (summary.frameId === root.frameId || entry.remote === true) {
                    entry.session = child;
                }
            }

            children.confirmMatched(child.child.sessionId);
        }
    }

    async routedChild(
        tab   : OwnedTab,
        method: string,
        params: Record<string, unknown> | undefined,
    ): Promise<FrameChildSession | undefined> {
        const sessionId = tab.sync.routeOf(method, params);

        if (sessionId === undefined || tab.children === undefined) return undefined;

        const children = await tab.children.catch(() => undefined);

        return children?.children().find((child) => child.child.sessionId === sessionId);
    }

    async replicate(
        targetId: string,
        tab     : OwnedTab,
        method  : string,
        params  : Record<string, unknown> | undefined,
    ): Promise<void> {
        tab.sync.record(method, params);
        const children = await this.childrenOf(targetId, tab).catch(() => undefined);

        await Promise.all((children?.children() ?? []).map((child) =>
            child.send(method, params, CHILD_COMMAND_TIMEOUT_MS).catch((error: unknown) =>
                logDaemon(`could not apply ${method} to an iframe session: ${describeError(error)}`))));
    }

    private async initChild(
        targetId: string,
        tab     : OwnedTab,
        child   : FrameChildSession,
    ): Promise<void> {
        this.assertCurrent(targetId, tab);
        for (const subscription of tab.subscriptions.values()) subscription.mirror?.(child);

        await Promise.all(tab.sync.replay().map((command) =>
            child.send(command.method, command.params, CHILD_COMMAND_TIMEOUT_MS).catch(
                (error: unknown) =>
                    logDaemon(`could not apply ${command.method} to an iframe session: ${describeError(error)}`),
            )));

        this.assertCurrent(targetId, tab);
    }

    mirror(
        targetId    : string,
        tab         : OwnedTab,
        subscription: Subscription,
        event       : string,
        child       : FrameChildSession,
    ): void {
        const sessionId = child.child.sessionId;

        if (subscription.mirrors.has(sessionId)) return;

        subscription.mirrors.set(sessionId, child.on(event, (params) => {
            tab.sync.note(sessionId, event, params);
            this.emit("cdp.event", { targetId, event, params });
        }));
    }

    private unsubscribeAll(tab: OwnedTab, frameId: string): void {
        for (const [key, entry] of [...tab.subscriptions]) {
            if (key === frameId || key.startsWith(`${frameId}|`)) {
                tab.subscriptions.delete(key);
                entry.off();
            }
        }
    }
}
