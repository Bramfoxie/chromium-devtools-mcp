import type net from "node:net";
import type { BrowserBackend } from "./browser-backend.js";
import { createRequestHandler } from "./handler.js";
import { describeError, logDaemon } from "./log.js";
import { acceptConnection, type ClientConnection, type RequestHandler } from "./server.js";
import { SessionRegistry } from "./sessions.js";

export interface DaemonOptions {
  backend: BrowserBackend;
  token: string;
  allowFocus: boolean;
  helloTimeoutMs?: number;
}

export class Daemon {
  private readonly registry: SessionRegistry<ClientConnection>;
  private readonly handler: RequestHandler;

  constructor(private readonly options: DaemonOptions) {
    this.registry = new SessionRegistry<ClientConnection>(options.backend, {
      allowFocus: options.allowFocus,
    });
    this.handler = createRequestHandler(this.registry);
  }

  accept = (socket: net.Socket): void => {
    acceptConnection(socket, {
      token: this.options.token,
      helloTimeoutMs: this.options.helloTimeoutMs,
      handler: this.handler,
      onClose: (connection) => {
        this.registry.close(connection).catch((error: unknown) => {
          logDaemon(`could not close a session: ${describeError(error)}`);
        });
      },
    });
  };

  shutdown(): Promise<void> {
    return this.registry.closeAll();
  }
}
