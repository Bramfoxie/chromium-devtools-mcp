import {
    CdpClosedError,
    CdpError,
    CdpProtocolError,
    CdpSessionDetachedError,
    CdpTimeoutError,
} from "./errors.js";
import { CdpSession } from "./session.js";
import type { TrafficObserver } from "./traffic-log.js";
import { type Transport, type TransportFactory, wsTransportFactory } from "./transport.js";
import { isRecord } from "../util/is-record.js";
import { messageOf } from "../util/message-of.js";
import { writeLogLine } from "../util/stderr.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface ConnectOptions {
    url              : string;
    createTransport? : TransportFactory;
    signal?          : AbortSignal;
    requestTimeoutMs?: number;
    traffic?         : TrafficObserver;
}

export interface SendOptions {
    sessionId?: string;
    timeoutMs?: number;
}

export interface SessionSendOptions {
    timeoutMs?: number;
}

export type EventHandler = (params: unknown, sessionId?: string) => void;

interface Pending {
    method   : string;
    sessionId: string | undefined;
    resolve  : (value: unknown) => void;
    reject   : (error: Error) => void;
    timer    : NodeJS.Timeout;
}

function closedError(): CdpClosedError {
    return new CdpClosedError("the client was closed or the browser disconnected");
}

function logError(message: string): void {
    try {
        writeLogLine(message);
    } catch {
    }
}

function checkTimeout(timeoutMs: number, where: string): void {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS) {
        throw new CdpError(
            `${where} must be a number of ms from 0 to ${MAX_TIMEOUT_MS}, got ${String(timeoutMs)}.`,
        );
    }
}

function listenerKey(event: string, sessionId: string | undefined): string {
    return `${sessionId ?? ""}|${event}`;
}

export class CdpClient {
    private nextId = 1;
    private isClosed = false;
    private closePromise: Promise<void> | undefined;
    private readonly pending = new Map<number, Pending>();
    private readonly listeners = new Map<string, Set<EventHandler>>();
    private readonly closeWaiters = new Set<{
        event    : string;
        sessionId: string | undefined;
        fail     : (error: Error) => void;
    }>();
    private readonly closeHandlers = new Set<() => void>();

    private constructor(
        private readonly transport       : Transport,
        private readonly requestTimeoutMs: number,
        private readonly traffic         : TrafficObserver | undefined,
    ) {
        transport.onMessage((data) => this.handleMessage(data));
        transport.onClose((reason) => this.shutdown(new CdpClosedError(reason)));
    }

    static async connect(options: ConnectOptions): Promise<CdpClient> {
        const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

        checkTimeout(requestTimeoutMs, "requestTimeoutMs");
        const createTransport = options.createTransport ?? wsTransportFactory;
        const transport = await createTransport(options.url, options.signal);

        return new CdpClient(transport, requestTimeoutMs, options.traffic);
    }

    get closed(): boolean {
        return this.isClosed;
    }

    send(method: string, params?: object, options: SendOptions = {}): Promise<unknown> {
        if (this.isClosed) return Promise.reject(closedError());

        const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;

        try {
            checkTimeout(timeoutMs, "timeoutMs");
        } catch (error) {
            return Promise.reject(error);
        }

        const id = this.nextId++;
        let payload: string;

        try {
            payload = JSON.stringify({ id, method, params, sessionId: options.sessionId });
        } catch (error) {
            return Promise.reject(
                new CdpError(
                    `cannot serialize the params of ${method} (${messageOf(error)}). Pass JSON-serializable params.`,
                    { cause: error },
                ),
            );
        }

        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new CdpTimeoutError(method, timeoutMs));
            }, timeoutMs);

            timer.unref();
            this.pending.set(id, { method, sessionId: options.sessionId, resolve, reject, timer });

            try {
                this.transport.send(payload);

                if (this.traffic !== undefined) {
                    this.observe({ direction: "sent", method, id, bytes: Buffer.byteLength(payload) });
                }
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new CdpClosedError(messageOf(error), { cause: error }));
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

        const listener: EventHandler = (params, id) => handler(params, id);

        handlers.add(listener);
        let active = true;

        return () => {
            if (!active) return;

            active = false;
            const current = this.listeners.get(key);

            if (!current || current !== handlers) return;

            current.delete(listener);
            if (current.size === 0) this.listeners.delete(key);
        };
    }

    once(event: string, sessionId?: string, timeoutMs?: number): Promise<unknown> {
        const limit = timeoutMs ?? this.requestTimeoutMs;

        if (this.isClosed) return Promise.reject(closedError());

        try {
            checkTimeout(limit, "timeoutMs");
        } catch (error) {
            return Promise.reject(error);
        }

        return new Promise<unknown>((resolve, reject) => {
            const waiter = {
                event,
                sessionId,
                fail: (error: Error) => {
                    finish();
                    reject(error);
                },
            };
            const finish = () => {
                clearTimeout(timer);
                off();
                this.closeWaiters.delete(waiter);
            };
            const timer = setTimeout(() => {
                finish();
                reject(new CdpTimeoutError(event, limit));
            }, limit);

            timer.unref();
            const off = this.on(
                event,
                (params) => {
                    finish();
                    resolve(params);
                },
                sessionId,
            );

            this.closeWaiters.add(waiter);
        });
    }

    onClose(handler: () => void): () => void {
        if (this.isClosed) {
            let cancelled = false;

            queueMicrotask(() => {
                if (!cancelled) this.runCloseHandler(handler);
            });

            return () => {
                cancelled = true;
            };
        }

        const listener = () => handler();

        this.closeHandlers.add(listener);

        return () => void this.closeHandlers.delete(listener);
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

    adoptSession(sessionId: string, targetId: string): CdpSession {
        return new CdpSession(this, sessionId, targetId);
    }

    dropSession(sessionId: string): void {
        const prefix = `${sessionId}|`;

        for (const [key, handlers] of this.listeners) {
            if (!key.startsWith(prefix)) continue;

            handlers.clear();
            this.listeners.delete(key);
        }

        const gone = (name: string) =>
            new CdpSessionDetachedError(name, sessionId);

        for (const [id, pending] of this.pending) {
            if (pending.sessionId !== sessionId) continue;

            clearTimeout(pending.timer);
            this.pending.delete(id);
            pending.reject(gone(pending.method));
        }

        for (const waiter of [...this.closeWaiters]) {
            if (waiter.sessionId !== sessionId) continue;

            this.closeWaiters.delete(waiter);
            waiter.fail(gone(waiter.event));
        }
    }

    close(): Promise<void> {
        if (!this.closePromise) {
            this.closePromise = Promise.resolve().then(() => this.transport.close());
            this.shutdown(new CdpClosedError("the client was closed"));
        }

        return this.closePromise;
    }

    private runCloseHandler(handler: () => void): void {
        try {
            handler();
        } catch (failure) {
            logError(`a close handler threw: ${messageOf(failure)}`);
        }
    }

    private shutdown(error: Error): void {
        if (this.isClosed) return;

        this.isClosed = true;

        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }

        this.pending.clear();
        for (const waiter of [...this.closeWaiters]) waiter.fail(error);
        this.closeWaiters.clear();

        for (const handler of [...this.closeHandlers]) {
            if (this.closeHandlers.has(handler)) this.runCloseHandler(handler);
        }

        this.closeHandlers.clear();
        this.listeners.clear();
    }

    private handleMessage(raw: string): void {
        if (this.isClosed) return;

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
            if (this.traffic !== undefined) {
                this.observe({
                    direction: "received",
                    id       : message.id,
                    method   : this.pending.get(message.id)?.method,
                    bytes    : Buffer.byteLength(raw),
                });
            }

            this.handleResponse(message.id, message);
        } else if (typeof message.method === "string") {
            if (this.traffic !== undefined) {
                this.observe({ direction: "received", method: message.method, bytes: Buffer.byteLength(raw) });
            }

            const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;

            this.dispatchEvent(message.method, message.params, sessionId);
        } else {
            logError("ignored a CDP message without an id and without a method");
        }
    }

    private observe(entry: Parameters<TrafficObserver>[0]): void {
        try {
            this.traffic?.(entry);
        } catch {
            logError("could not record CDP traffic metadata");
        }
    }

    private handleResponse(id: number, message: Record<string, unknown>): void {
        const pending = this.pending.get(id);

        if (!pending) {
            if (id < this.nextId) return;

            logError(`ignored a CDP response with unknown id ${id}`);

            return;
        }

        clearTimeout(pending.timer);
        this.pending.delete(id);
        const failure = message.error;

        if (failure !== undefined) {
            const record = isRecord(failure) ? failure : undefined;
            const code = typeof record?.code === "number" ? record.code : undefined;
            const detail =
                typeof record?.message === "string"
                    ? record.message
                    : record
                        ? "no details"
                        : messageOf(failure);

            pending.reject(new CdpProtocolError(pending.method, code, detail));
        } else {
            pending.resolve(message.result);
        }
    }

    private dispatchEvent(method: string, params: unknown, sessionId: string | undefined): void {
        const handlers = this.listeners.get(listenerKey(method, sessionId));

        if (handlers) {
            for (const handler of [...handlers]) {
                if (this.isClosed || !handlers.has(handler)) continue;

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
