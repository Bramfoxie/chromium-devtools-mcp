import net from "node:net";
import { IpcCancelledError, IpcClosedError, IpcTimeoutError, RpcError } from "./errors.js";
import { declaredTimeoutMs, timeoutClassOf } from "./request-timeouts.js";
import { describeError, logDaemon, quoted } from "../util/log.js";
import {
    encodeMessage,
    LineDecoder,
    MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES,
    DaemonEvent,
    failureParamsSchema,
    parseLine,
    serverMessageSchema,
} from "./protocol.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DECLARED_TIMEOUT_MARGIN_MS = 5000;
const MULTI_STEP_TIMEOUT_MARGIN_MS = 30_000;

export interface IpcConnectOptions {
    socketPath       : string;
    token            : string;
    clientName       : string;
    connectTimeoutMs?: number;
    requestTimeoutMs?: number;
}

export type IpcEventHandler = (params: unknown) => void;

interface Pending {
    method : string;
    resolve: (value: unknown) => void;
    reject : (error: Error) => void;
    timer  : NodeJS.Timeout;
}

export class IpcClient {
    private nextId = 1;
    private isClosed = false;
    private readonly pending = new Map<number, Pending>();
    private readonly handlers = new Map<string, Set<IpcEventHandler>>();
    private readonly decoder = new LineDecoder(MAX_RESPONSE_BYTES);
    private readonly closedSignal: Promise<void>;
    private hello                : unknown;
    private reportedFailure      : string | undefined;

    private constructor(
        private readonly socket          : net.Socket,
        private readonly requestTimeoutMs: number,
    ) {
        this.closedSignal = new Promise((resolve) => socket.once("close", () => resolve()));
        socket.on("data", (chunk: Buffer) => this.handleData(chunk));
        socket.on("error", () => undefined);
        socket.once("close", () =>
            this.shutdown(new IpcClosedError("the daemon closed the connection")),
        );
    }

    static async connect(options: IpcConnectOptions): Promise<IpcClient> {
        const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        const socket = await openSocket(options.socketPath, connectTimeoutMs);
        const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        const client = new IpcClient(socket, requestTimeoutMs);

        try {
            client.hello = await client.request(
                "hello",
                { token: options.token, clientName: options.clientName },
                { timeoutMs: connectTimeoutMs },
            );
        } catch (error) {
            await client.close();

            if (error instanceof IpcClosedError) {
                throw new IpcClosedError(
                    "the daemon rejected the handshake. Check that the token file is current and that the daemon runs as the same user",
                );
            }

            throw error;
        }

        return client;
    }

    get helloResult(): unknown {
        return this.hello;
    }

    get failure(): string | undefined {
        return this.reportedFailure;
    }

    get closed(): boolean {
        return this.isClosed;
    }

    request(
        method : string,
        params?: unknown,
        options: { timeoutMs?: number; signal?: AbortSignal } = {},
    ): Promise<unknown> {
        if (this.isClosed || this.socket.destroyed) {
            return Promise.reject(new IpcClosedError("the client was closed"));
        }

        if (options.signal?.aborted) return Promise.reject(new IpcCancelledError(method));

        const id = this.nextId++;
        const timeoutMs = options.timeoutMs ?? this.timeoutFor(method, params);
        let line: string;

        try {
            line = encodeMessage({ id, method, params }, MAX_REQUEST_BYTES);
        } catch (error) {
            return Promise.reject(error);
        }

        return new Promise<unknown>((resolve, reject) => {
            const detach = (): void => options.signal?.removeEventListener("abort", onAbort);
            const settle = {
                resolve: (value: unknown): void => {
                    detach();
                    resolve(value);
                },
                reject: (error: Error): void => {
                    detach();
                    reject(error);
                },
            };
            const timer = setTimeout(() => {
                this.pending.delete(id);
                settle.reject(new IpcTimeoutError(method, timeoutMs));
            }, timeoutMs);
            const onAbort = (): void => {
                clearTimeout(timer);
                this.pending.delete(id);
                settle.reject(new IpcCancelledError(method));
            };

            options.signal?.addEventListener("abort", onAbort, { once: true });
            this.pending.set(id, { method, ...settle, timer });
            this.socket.write(line);
        });
    }

    private timeoutFor(method: string, params: unknown): number {
        const declared = declaredTimeoutMs(params);
        const timeoutClass = timeoutClassOf(method);

        if (timeoutClass === "multi-step") {
            return (declared ?? this.requestTimeoutMs) + MULTI_STEP_TIMEOUT_MARGIN_MS;
        }

        if (declared !== undefined) {
            return Math.max(this.requestTimeoutMs, declared + DECLARED_TIMEOUT_MARGIN_MS);
        }

        return timeoutClass === "cdp-bound"
            ? this.requestTimeoutMs + DECLARED_TIMEOUT_MARGIN_MS
            : this.requestTimeoutMs;
    }

    on(event: string, handler: IpcEventHandler): () => void {
        if (this.isClosed) return () => undefined;

        let set = this.handlers.get(event);

        if (!set) {
            set = new Set();
            this.handlers.set(event, set);
        }

        set.add(handler);

        return () => {
            const current = this.handlers.get(event);

            if (!current) return;

            current.delete(handler);
            if (current.size === 0) this.handlers.delete(event);
        };
    }

    async close(): Promise<void> {
        this.shutdown(new IpcClosedError("the client was closed"));
        this.socket.destroy();
        await this.closedSignal;
    }

    private shutdown(error: Error): void {
        if (this.isClosed) return;

        this.isClosed = true;

        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }

        this.pending.clear();
        this.handlers.clear();
    }

    private handleData(chunk: Buffer): void {
        try {
            for (const line of this.decoder.push(chunk)) this.handleLine(line);
        } catch (error) {
            logDaemon(`closing the connection to the daemon: ${describeError(error)}`);
            this.shutdown(new IpcClosedError("the daemon sent an invalid message"));
            this.socket.destroy();
        }
    }

    private handleLine(line: string): void {
        const parsed = serverMessageSchema.safeParse(parseLine(line));

        if (!parsed.success) {
            logDaemon("ignored an unrecognized daemon message");

            return;
        }

        const message = parsed.data;

        if ("event" in message) {
            if (message.event === DaemonEvent.failed) {
                const failure = failureParamsSchema.safeParse(message.params);

                if (failure.success) this.reportedFailure = failure.data.message;
            }

            for (const handler of [...(this.handlers.get(message.event) ?? [])]) {
                try {
                    handler(message.params);
                } catch (error) {
                    logDaemon(`a handler for ${quoted(message.event)} threw: ${describeError(error)}`);
                }
            }

            return;
        }

        const pending = this.pending.get(message.id);

        if (!pending) return;

        clearTimeout(pending.timer);
        this.pending.delete(message.id);

        if ("error" in message) {
            pending.reject(new RpcError(message.error.code, message.error.message));
        } else {
            pending.resolve(message.result);
        }
    }
}

function openSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(socketPath);
        const fail = (detail: string) => {
            socket.destroy();
            reject(
                new IpcClosedError(
                    `cannot reach the daemon at ${socketPath} (${detail}). Start the daemon or check that it runs as the same user`,
                ),
            );
        };

        socket.setTimeout(timeoutMs, () => fail("connection timed out"));
        socket.once("error", (error: NodeJS.ErrnoException) => fail(error.code ?? error.message));
        socket.once("connect", () => {
            socket.setTimeout(0);
            socket.removeAllListeners("error");
            resolve(socket);
        });
    });
}
