import type net from "node:net";
import type { BrowserBackend } from "./browser-backend.js";
import { createRequestHandler, type DaemonStatus } from "./handler.js";
import type { DaemonIdentity } from "./identity.js";
import { boundedFailureMessage, DaemonEvent } from "./protocol.js";
import { describeError, logDaemon } from "../util/log.js";
import {
    acceptConnection,
    type ClientConnection,
    PendingConnections,
    type RequestHandler,
} from "./server.js";
import { SessionRegistry } from "./sessions.js";

const FAILURE_FLUSH_TIMEOUT_MS = 1000;

export interface DaemonOptions {
    token          : string;
    allowFocus     : boolean;
    downloadsRoot? : string;
    platform?      : NodeJS.Platform;
    identity       : DaemonIdentity;
    helloTimeoutMs?: number;
    idleTimeoutMs? : number;
    onIdle?        : () => void;
    onStop?        : () => void;
}

export class Daemon {
    private registry        : SessionRegistry<ClientConnection> | undefined;
    private readonly handler: RequestHandler;
    private state           : DaemonStatus["state"] = "starting";
    private message         : string | undefined;
    private clients = 0;
    private idleTimer       : NodeJS.Timeout | undefined;
    private stopped = false;
    private idleArmed = false;
    private readonly pending = new PendingConnections();
    private readonly connections = new Set<ClientConnection>();

    constructor(private readonly options: DaemonOptions) {
        this.handler = createRequestHandler({
            registry: () => this.registry,
            status  : () => this.status(),
            stop    : () => this.requestStop(),
        });
    }

    status(): DaemonStatus {
        return {
            state  : this.state,
            browser: this.options.identity.browser,
            mode   : this.options.identity.mode,
            ...(this.message === undefined ? {} : { message: this.message }),
        };
    }

    private requestStop(): void {
        setImmediate(() => {
            try {
                this.options.onStop?.();
            } catch (error) {
                logDaemon(`onStop failed: ${describeError(error)}`);
            }
        });
    }

    setWaiting(message: string): void {
        if (this.registry) return;

        this.state = "waiting";
        this.message = message;
    }

    setBackend(backend: BrowserBackend): void {
        this.registry = new SessionRegistry<ClientConnection>(backend, {
            allowFocus: this.options.allowFocus,
            ...(this.options.downloadsRoot === undefined
                ? {}
                : { downloadsRoot: this.options.downloadsRoot }),
            ...(this.options.platform === undefined ? {} : { platform: this.options.platform }),
        });
        this.state = "ready";
        this.message = undefined;
        this.armIdle();
    }

    armIdle(): void {
        this.idleArmed = true;
        this.scheduleIdle();
    }

    accept = (socket: net.Socket): void => {
        acceptConnection(socket, {
            token         : this.options.token,
            pending       : this.pending,
            helloTimeoutMs: this.options.helloTimeoutMs,
            helloResult   : () => this.options.identity,
            handler       : this.handler,
            onReady       : (connection) => {
                this.connections.add(connection);
                this.clients += 1;
                this.cancelIdle();
            },
            onClose: (connection) => {
                this.connections.delete(connection);
                this.clients -= 1;
                this.scheduleIdle();
                this.registry?.close(connection).catch((error: unknown) => {
                    logDaemon(`could not close a session: ${describeError(error)}`);
                });
            },
        });
    };

    async announceFailure(
        reason        : string,
        flushTimeoutMs: number = FAILURE_FLUSH_TIMEOUT_MS,
    ): Promise<void> {
        const message = boundedFailureMessage(reason);
        const sent = [...this.connections].map((connection) =>
            connection.sendFinalEvent(DaemonEvent.failed, { message }),
        );
        let timer: NodeJS.Timeout | undefined;
        const bound = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, flushTimeoutMs);
        });

        try {
            await Promise.race([Promise.all(sent), bound]);
        } finally {
            clearTimeout(timer);
        }
    }

    async shutdown(): Promise<void> {
        this.stopped = true;
        this.cancelIdle();
        await this.registry?.closeAll();
    }

    private cancelIdle(): void {
        clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
    }

    private scheduleIdle(): void {
        this.cancelIdle();
        const timeout = this.options.idleTimeoutMs;

        if (this.stopped || !this.idleArmed || this.clients > 0 || timeout === undefined) return;

        this.idleTimer = setTimeout(() => {
            try {
                this.options.onIdle?.();
            } catch (error) {
                logDaemon(`onIdle failed: ${describeError(error)}`);
            }
        }, timeout);
    }
}
