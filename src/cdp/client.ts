import { CdpClosedError, CdpError, CdpProtocolError, CdpTimeoutError } from "./errors.js";
import { CdpSession } from "./session.js";
import { type Transport, type TransportFactory, wsTransportFactory } from "./transport.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface ConnectOptions {
  url: string;
  createTransport?: TransportFactory;
  requestTimeoutMs?: number;
}

export interface SendOptions {
  sessionId?: string;
  timeoutMs?: number;
}

export type EventHandler = (params: unknown, sessionId?: string) => void;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logError(message: string): void {
  process.stderr.write(`chromium-devtools-mcp: ${message}\n`);
}

function listenerKey(event: string, sessionId: string | undefined): string {
  return `${sessionId ?? ""}|${event}`;
}

export class CdpClient {
  private nextId = 1;
  private isClosed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<EventHandler>>();
  private readonly closeWaiters = new Set<(error: Error) => void>();

  private constructor(
    private readonly transport: Transport,
    private readonly requestTimeoutMs: number,
  ) {
    transport.onMessage((data) => this.handleMessage(data));
    transport.onClose((reason) => this.shutdown(new CdpClosedError(reason)));
  }

  static async connect(options: ConnectOptions): Promise<CdpClient> {
    const createTransport = options.createTransport ?? wsTransportFactory;
    const transport = await createTransport(options.url);
    return new CdpClient(transport, options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  send(method: string, params?: object, options: SendOptions = {}): Promise<unknown> {
    if (this.isClosed) {
      return Promise.reject(
        new CdpClosedError("the client was closed or the browser disconnected"),
      );
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    let payload: string;
    try {
      payload = JSON.stringify({ id, method, params, sessionId: options.sessionId });
    } catch (error) {
      return Promise.reject(
        new CdpError(
          `cannot serialize the params of ${method} (${messageOf(error)}). Pass JSON-serializable params.`,
        ),
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.transport.send(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpClosedError(messageOf(error)));
      }
    });
  }

  on(event: string, handler: EventHandler, sessionId?: string): () => void {
    const key = listenerKey(event, sessionId);
    let handlers = this.listeners.get(key);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(key, handlers);
    }
    handlers.add(handler);
    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.listeners.delete(key);
    };
  }

  once(event: string, sessionId?: string, timeoutMs?: number): Promise<unknown> {
    const limit = timeoutMs ?? this.requestTimeoutMs;
    if (this.isClosed) {
      return Promise.reject(
        new CdpClosedError("the client was closed or the browser disconnected"),
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        off();
        this.closeWaiters.delete(onClosed);
      };
      const onClosed = (error: Error) => {
        finish();
        reject(error);
      };
      const timer = setTimeout(() => {
        finish();
        reject(new CdpTimeoutError(event, limit));
      }, limit);
      const off = this.on(
        event,
        (params) => {
          finish();
          resolve(params);
        },
        sessionId,
      );
      this.closeWaiters.add(onClosed);
    });
  }

  async attach(targetId: string): Promise<CdpSession> {
    const result = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = isRecord(result) ? result.sessionId : undefined;
    if (typeof sessionId !== "string") {
      throw new CdpProtocolError(
        "Target.attachToTarget",
        undefined,
        "the response has no sessionId",
      );
    }
    return new CdpSession(this, sessionId, targetId);
  }

  dropSession(sessionId: string): void {
    const prefix = `${sessionId}|`;
    for (const key of this.listeners.keys()) {
      if (key.startsWith(prefix)) this.listeners.delete(key);
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.shutdown(new CdpClosedError("the client was closed"));
    await this.transport.close();
  }

  private shutdown(error: Error): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of [...this.closeWaiters]) waiter(error);
    this.closeWaiters.clear();
    this.listeners.clear();
  }

  private handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      logError("ignored a CDP message that is not valid JSON");
      return;
    }
    if (!isRecord(message)) {
      logError("ignored a CDP message that is not an object");
      return;
    }
    if (typeof message.id === "number") {
      this.handleResponse(message.id, message);
    } else if (typeof message.method === "string") {
      const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
      this.dispatchEvent(message.method, message.params, sessionId);
    }
  }

  private handleResponse(id: number, message: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) {
      logError(`ignored a CDP response with unknown id ${id}`);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    const failure = message.error;
    if (isRecord(failure)) {
      const code = typeof failure.code === "number" ? failure.code : undefined;
      const detail = typeof failure.message === "string" ? failure.message : "no details";
      pending.reject(new CdpProtocolError(pending.method, code, detail));
    } else {
      pending.resolve(message.result);
    }
  }

  private dispatchEvent(method: string, params: unknown, sessionId: string | undefined): void {
    const handlers = this.listeners.get(listenerKey(method, sessionId));
    if (handlers) {
      for (const handler of [...handlers]) {
        if (!handlers.has(handler)) continue;
        try {
          handler(params, sessionId);
        } catch (error) {
          logError(`an event handler for ${method} threw: ${messageOf(error)}`);
        }
      }
    }
    if (method === "Target.detachedFromTarget" && isRecord(params)) {
      if (typeof params.sessionId === "string") this.dropSession(params.sessionId);
    }
  }
}
