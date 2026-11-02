import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { type RawData, type WebSocket, WebSocketServer } from "ws";

interface Rpc {
    id        : number;
    method    : string;
    params?   : Record<string, unknown>;
    sessionId?: string;
}

interface FakeTarget {
    type            : string;
    url             : string;
    title           : string;
    browserContextId: string | undefined;
}

interface FakeChild {
    targetId : string;
    sessionId: string;
    frameId  : string;
    url      : string;
    parent   : string;
}

export class FakeBrowser {
    readonly defaultContext = "DEFAULT-CONTEXT";
    readonly contexts = new Set<string>();
    readonly targets = new Map<string, FakeTarget>();
    readonly calls: Rpc[] = [];
    reportDefaultContext = true;
    failures = new Map<string, { code: number; message: string }>();
    malformed = new Set<string>();
    silent = new Set<string>();
    private readonly sockets = new Set<WebSocket>();
    private readonly server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    private discovering = false;
    private counter = 0;
    private sessions = new Map<string, string>();
    private autoAttached = new Set<string>();
    private readonly children = new Map<string, FakeChild>();

    async start(): Promise<string> {
        await once(this.server, "listening");
        this.server.on("connection", (socket) => {
            this.sockets.add(socket);
            socket.on("close", () => this.sockets.delete(socket));
            socket.on("message", (data: RawData) =>
                this.handle(socket, JSON.parse(data.toString()) as Rpc),
            );
        });

        return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    }

    async stop(): Promise<void> {
        this.dropConnections();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    dropConnections(): void {
        for (const socket of this.sockets) socket.terminate();
    }

    addTarget(type: string, url: string, browserContextId?: string): string {
        const id = `T${++this.counter}`;

        this.targets.set(id, { type, url, title: `title ${url}`, browserContextId });

        return id;
    }

    emitSessionEvent(targetId: string, event: string, params: unknown): void {
        for (const [sessionId, target] of this.sessions) {
            if (target === targetId) this.broadcast({ method: event, params, sessionId });
        }
    }

    emitChildEvent(sessionId: string, event: string, params: unknown): void {
        if (this.children.has(sessionId)) this.broadcast({ method: event, params, sessionId });
    }

    childSessionIds(): string[] {
        return [...this.children.keys()];
    }

    attachChild(parentTargetId: string, frameId: string, url: string): string {
        const parent = [...this.sessions].find(([, target]) => target === parentTargetId)?.[0];

        return parent === undefined ? "" : this.attachUnder(parent, frameId, url);
    }

    attachNestedChild(parentChildSessionId: string, frameId: string, url: string): string {
        return this.attachUnder(parentChildSessionId, frameId, url);
    }

    private attachUnder(parent: string, frameId: string, url: string): string {
        if (!this.autoAttached.has(parent)) return "";

        const sessionId = `S${++this.counter}`;
        const targetId = `T${++this.counter}`;

        this.children.set(sessionId, { targetId, sessionId, frameId, url, parent });
        this.broadcast({
            method: "Target.attachedToTarget",
            params: {
                sessionId,
                targetInfo        : { targetId, type: "iframe", url },
                waitingForDebugger: false,
            },
            sessionId: parent,
        });

        return sessionId;
    }

    private frameTree(sessionId: string): unknown {
        const child = this.children.get(sessionId);
        const target = this.targets.get(this.sessions.get(sessionId) ?? "");
        const nodes = (parent: string, parentFrameId: string): unknown[] =>
            [...this.children.values()]
                .filter((entry) => entry.parent === parent)
                .map((entry) => ({
                    frame      : { id: entry.frameId, parentId: parentFrameId, url: entry.url },
                    childFrames: nodes(entry.sessionId, entry.frameId),
                }));

        if (child) {
            return {
                frameTree: {
                    frame      : { id: child.frameId, url: child.url },
                    childFrames: nodes(child.sessionId, child.frameId),
                },
            };
        }

        const mainId = `main-${this.sessions.get(sessionId)}`;

        return {
            frameTree: {
                frame      : { id: mainId, url: target?.url ?? "" },
                childFrames: nodes(sessionId, mainId),
            },
        };
    }

    detachChild(sessionId: string): void {
        const child = this.children.get(sessionId);

        if (!child) return;

        this.children.delete(sessionId);
        // Real Chrome wraps the child detach in the session of its parent.
        this.broadcast({
            method   : "Target.detachedFromTarget",
            params   : { sessionId, targetId: child.targetId },
            sessionId: child.parent,
        });
    }

    emitRaw(method: string, params: unknown): void {
        this.broadcast({ method, params });
    }

    destroyFromOutside(targetId: string): void {
        this.destroy(targetId);
    }

    private broadcast(message: unknown): void {
        for (const socket of this.sockets) socket.send(JSON.stringify(message));
    }

    private destroy(targetId: string): void {
        if (!this.targets.delete(targetId)) return;
        if (this.discovering)
            this.broadcast({ method: "Target.targetDestroyed", params: { targetId } });
    }

    private handle(socket: WebSocket, rpc: Rpc): void {
        this.calls.push(rpc);
        const reply = (result: unknown) =>
            socket.send(JSON.stringify({ id: rpc.id, result, sessionId: rpc.sessionId }));

        if (this.silent.has(rpc.method)) return;

        const failure = this.failures.get(rpc.method);

        if (failure) {
            socket.send(JSON.stringify({ id: rpc.id, error: failure }));

            return;
        }

        if (this.malformed.has(rpc.method)) {
            reply({ unexpected: true });

            return;
        }

        const params = rpc.params ?? {};

        switch (rpc.method) {
            case "Target.setDiscoverTargets":
                this.discovering = params.discover === true;
                reply({});

                return;
            case "Target.getBrowserContexts":
                reply({
                    browserContextIds: [...this.contexts],
                    ...(this.reportDefaultContext
                        ? { defaultBrowserContextId: this.defaultContext }
                        : {}),
                });

                return;

            case "Target.createBrowserContext": {
                const id = `CTX${++this.counter}`;

                this.contexts.add(id);
                reply({ browserContextId: id });

                return;
            }

            case "Target.disposeBrowserContext": {
                const id = String(params.browserContextId);

                if (!this.contexts.has(id)) {
                    socket.send(
                        JSON.stringify({
                            id   : rpc.id,
                            error: { code: -32000, message: "Failed to find context" },
                        }),
                    );

                    return;
                }

                this.contexts.delete(id);

                for (const [targetId, target] of [...this.targets]) {
                    if (target.browserContextId === id) this.destroy(targetId);
                }

                reply({});

                return;
            }

            case "Target.createTarget": {
                const context = params.browserContextId as string | undefined;

                reply({
                    targetId: this.addTarget("page", String(params.url), context ?? this.defaultContext),
                });

                return;
            }

            case "Target.closeTarget":
                if (!this.targets.has(String(params.targetId))) {
                    socket.send(
                        JSON.stringify({
                            id   : rpc.id,
                            error: { code: -32602, message: "No target with given id found" },
                        }),
                    );

                    return;
                }

                reply({ success: true });
                this.destroy(String(params.targetId));

                return;
            case "Target.getTargets":
                reply({
                    targetInfos: [...this.targets].map(([targetId, target]) => ({
                        targetId,
                        ...target,
                    })),
                });

                return;

            case "Target.attachToTarget": {
                if (!this.targets.has(String(params.targetId))) {
                    socket.send(
                        JSON.stringify({
                            id   : rpc.id,
                            error: { code: -32602, message: "No target with given id found" },
                        }),
                    );

                    return;
                }

                const sessionId = `S${++this.counter}`;

                this.sessions.set(sessionId, String(params.targetId));
                reply({ sessionId });

                return;
            }

            case "Target.detachFromTarget":
                this.sessions.delete(String(params.sessionId));
                this.children.delete(String(params.sessionId));
                reply({});

                return;

            case "Target.setAutoAttach":
                if (rpc.sessionId !== undefined) this.autoAttached.add(rpc.sessionId);

                reply({});

                return;
            case "Page.getFrameTree":
                if (rpc.sessionId !== undefined) {
                    reply(this.frameTree(rpc.sessionId));

                    return;
                }

                reply({ echoed: rpc.method });

                return;
            default:
                reply({ echoed: rpc.method });
        }
    }
}
