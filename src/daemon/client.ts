import net from "node:net";
import { IpcClosedError, IpcTimeoutError, RpcError } from "./errors.js";
import { describeError, logDaemon, quoted } from "./log.js";
import { encodeMessage, LineDecoder, parseLine, serverMessageSchema } from "./protocol.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DECLARED_TIMEOUT_MARGIN_MS = 5000;

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
    private readonly decoder = new LineDecoder();
    private readonly closedSignal: Promise<void>;
    private hello                : unknown;

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

    get closed(): boolean {
        return this.isClosed;
    }

    request(
        method : string,
        params?: unknown,
        options: { timeoutMs?: number } = {},
    ): Promise<unknown> {
        if (this.isClosed || this.socket.destroyed) {
            return Promise.reject(new IpcClosedError("the client was closed"));
        }

        const id = this.nextId++;
        const timeoutMs = options.timeoutMs ?? this.timeoutFor(params);
        let line: string;

        try {
            line = encodeMessage({ id, method, params });
        } catch (error) {
            return Promise.reject(error);
        }

        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new IpcTimeoutError(method, timeoutMs));
            }, timeoutMs);

            this.pending.set(id, { method, resolve, reject, timer });
            this.socket.write(line);
        });
    }

    // A declared timeoutMs, as in cdp.send, sets the wait plus a margin.
    private timeoutFor(params: unknown): number {
        const declared = (params as { timeoutMs?: unknown } | null | undefined)?.timeoutMs;

        return typeof declared === "number" && Number.isFinite(declared)
            ? Math.max(this.requestTimeoutMs, declared + DECLARED_TIMEOUT_MARGIN_MS)
            : this.requestTimeoutMs;
    }

    // Subscribing after close silently returns a no-op; the handler never fires.
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
