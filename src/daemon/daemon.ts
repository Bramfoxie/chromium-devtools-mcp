import type net from "node:net";
import type { BrowserBackend } from "./browser-backend.js";
import { createRequestHandler, type DaemonStatus } from "./handler.js";
import { describeError, logDaemon } from "./log.js";
import { acceptConnection, type ClientConnection, type RequestHandler } from "./server.js";
import { SessionRegistry } from "./sessions.js";

export interface DaemonOptions {
  token: string;
  allowFocus: boolean;
  identity: { browser: string; mode: string };
  helloTimeoutMs?: number;
  idleTimeoutMs?: number;
  onIdle?: () => void;
}

export class Daemon {
  private registry: SessionRegistry<ClientConnection> | undefined;
  private readonly handler: RequestHandler;
  private state: DaemonStatus["state"] = "starting";
  private message: string | undefined;
  private clients = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly options: DaemonOptions) {
    this.handler = createRequestHandler({
      registry: () => this.registry,
      status: () => this.status(),
    });
  }

  status(): DaemonStatus {
    return {
      state: this.state,
      browser: this.options.identity.browser,
      mode: this.options.identity.mode,
      ...(this.message === undefined ? {} : { message: this.message }),
    };
  }

  setWaiting(message: string): void {
    if (this.registry) return;
    this.state = "waiting";
    this.message = message;
  }

  setBackend(backend: BrowserBackend): void {
    this.registry = new SessionRegistry<ClientConnection>(backend, {
      allowFocus: this.options.allowFocus,
    });
    this.state = "ready";
    this.message = undefined;
    this.scheduleIdle();
  }

  accept = (socket: net.Socket): void => {
    acceptConnection(socket, {
      token: this.options.token,
      helloTimeoutMs: this.options.helloTimeoutMs,
      helloResult: () => this.options.identity,
      handler: this.handler,
      onReady: () => {
        this.clients += 1;
        this.cancelIdle();
      },
      onClose: (connection) => {
        this.clients -= 1;
        this.scheduleIdle();
        this.registry?.close(connection).catch((error: unknown) => {
          logDaemon(`could not close a session: ${describeError(error)}`);
        });
      },
    });
  };

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
    if (this.stopped || !this.registry || this.clients > 0 || timeout === undefined) return;
    this.idleTimer = setTimeout(() => this.options.onIdle?.(), timeout);
  }
}
