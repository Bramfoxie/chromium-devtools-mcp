import type { IpcClient } from "../../src/daemon/index.js";
import type { DaemonLink, SessionResetHandler } from "../../src/mcp/index.js";

type Handler = (method: string, params: unknown) => unknown | Promise<unknown>;

export class FakeLinkClient {
    closed = false;
    readonly calls: Array<{ method: string; params: unknown; options?: { timeoutMs?: number } }> =
        [];
    readonly events = new Map<string, Set<(params: unknown) => void>>();
    closes = 0;

    constructor(private readonly handler: Handler = () => ({})) {}

    async request(
        method  : string,
        params? : unknown,
        options?: { timeoutMs?: number },
    ): Promise<unknown> {
        this.calls.push({ method, params, options });

        return this.handler(method, params);
    }

    on(event: string, handler: (params: unknown) => void): () => void {
        let set = this.events.get(event);

        if (!set) {
            set = new Set();
            this.events.set(event, set);
        }

        set.add(handler);

        return () => void set.delete(handler);
    }

    emit(event: string, params: unknown): void {
        for (const handler of [...(this.events.get(event) ?? [])]) handler(params);
    }

    async close(): Promise<void> {
        this.closes += 1;
        this.closed = true;
    }
}

export class FakeLink {
    readonly clients: FakeLinkClient[] = [];
    readonly resets = new Set<SessionResetHandler>();
    generation = 0;
    reuseClient = false;

    constructor(private readonly handler: Handler = () => ({})) {}

    get sessionGeneration(): number {
        return this.generation;
    }

    onSessionReset(handler: SessionResetHandler): () => void {
        this.resets.add(handler);

        return () => void this.resets.delete(handler);
    }

    resetSession(): void {
        this.generation += 1;
        for (const handler of [...this.resets]) handler();
    }

    async request(method: string, params?: unknown): Promise<unknown> {
        return this.current().request(method, params);
    }

    async ready(): Promise<IpcClient> {
        return this.current() as unknown as IpcClient;
    }

    async close(): Promise<void> {
        for (const client of this.clients) await client.close();
    }

    asLink(): DaemonLink {
        return this as unknown as DaemonLink;
    }

    private current(): FakeLinkClient {
        const last = this.clients[this.clients.length - 1];

        const current = this.reuseClient || this.clients.length === this.generation + 1;

        if (last && !last.closed && current) return last;

        const client = new FakeLinkClient(this.handler);

        this.clients.push(client);

        return client;
    }
}
