import type { BackendSession, BrowserBackend, TargetInfo } from "../../src/daemon/index.js";

interface SentCommand {
  method   : string;
  params   : object | undefined;
  timeoutMs: number | undefined;
}

export class FakeSession implements BackendSession {
  sent   : SentCommand[] = [];
  detached = false;
  failure: Error | undefined;
  private readonly handlers = new Map<string, Set<(params: unknown) => void>>();

  constructor(
    readonly targetId: string,
    private readonly log: string[],
  ) {}

  async send(method: string, params: object | undefined, timeoutMs?: number): Promise<unknown> {
    this.sent.push({ method, params, timeoutMs });
    if (this.failure) throw this.failure;

    return { echoed: method, target: this.targetId };
  }

  on(event: string, handler: (params: unknown) => void): () => void {
    let set = this.handlers.get(event);

    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }

    set.add(handler);

    return () => void set.delete(handler);
  }

  async detach(): Promise<void> {
    this.detached = true;
    this.log.push(`detach ${this.targetId}`);
  }

  emit(event: string, params: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(params);
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

export class FakeBackend implements BrowserBackend {
  readonly log: string[] = [];
  readonly contexts = new Set<string>();
  readonly targets = new Map<
    string,
    { url: string; title: string; contextId: string | undefined }
  >();
  readonly sessions = new Map<string, FakeSession>();
  failures: Partial<Record<"createContext" | "createTarget" | "closeTarget" | "attach", Error[]>> =
    {};
  gates: Partial<
    Record<
      "createContext" | "createTarget" | "listTargets" | "closeTarget" | "attach",
      Promise<void>
    >
  > = {};
  afterCreate: ((targetId: string) => void) | undefined;
  private readonly destroyed = new Set<(targetId: string) => void>();
  private readonly disconnected = new Set<() => void>();
  private counter = 0;

  private fail(name: keyof FakeBackend["failures"]): void {
    const error = this.failures[name]?.shift();

    if (error) throw error;
  }

  async createContext(): Promise<string> {
    await this.gates.createContext;
    this.fail("createContext");
    const id = `ctx${++this.counter}`;

    this.contexts.add(id);
    this.log.push(`createContext ${id}`);

    return id;
  }

  async disposeContext(contextId: string): Promise<void> {
    this.contexts.delete(contextId);
    this.log.push(`disposeContext ${contextId}`);

    for (const [targetId, target] of [...this.targets]) {
      if (target.contextId === contextId) this.destroyTarget(targetId);
    }
  }

  async createTarget(url: string, contextId: string | undefined): Promise<string> {
    await this.gates.createTarget;
    this.fail("createTarget");
    const id = `tab${++this.counter}`;

    this.targets.set(id, { url, title: `title of ${url}`, contextId });
    this.log.push(`createTarget ${id} ${contextId ?? "default"} ${url}`);
    this.afterCreate?.(id);

    return id;
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.gates.closeTarget;
    this.fail("closeTarget");
    this.log.push(`closeTarget ${targetId}`);
    this.destroyTarget(targetId);
  }

  async listTargets(): Promise<TargetInfo[]> {
    const snapshot = [...this.targets];

    await this.gates.listTargets;

    return snapshot.map(([targetId, target]) => ({ targetId, ...target }));
  }

  async attach(targetId: string): Promise<BackendSession> {
    await this.gates.attach;
    this.fail("attach");
    const session = new FakeSession(targetId, this.log);

    this.sessions.set(targetId, session);
    this.log.push(`attach ${targetId}`);

    return session;
  }

  onTargetDestroyed(handler: (targetId: string) => void): () => void {
    this.destroyed.add(handler);

    return () => void this.destroyed.delete(handler);
  }

  onDisconnected(handler: () => void): () => void {
    this.disconnected.add(handler);

    return () => void this.disconnected.delete(handler);
  }

  async close(): Promise<void> {
    this.log.push("close");
    this.disconnect();
  }

  disconnect(): void {
    for (const handler of [...this.disconnected]) handler();
  }

  seedTab(url: string, contextId?: string): string {
    const id = `tab${++this.counter}`;

    this.targets.set(id, { url, title: `title of ${url}`, contextId });

    return id;
  }

  destroyTarget(targetId: string): void {
    this.targets.delete(targetId);
    for (const handler of [...this.destroyed]) handler(targetId);
  }

  get destroyListenerCount(): number {
    return this.destroyed.size;
  }
}
