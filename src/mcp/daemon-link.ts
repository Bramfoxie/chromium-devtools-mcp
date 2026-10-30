import {
  DaemonError,
  DaemonNotRunningError,
  ErrorCode,
  type IpcClient,
  IpcClosedError,
  RpcError,
} from "../daemon/index.js";

export class DaemonNotReadyError extends DaemonError {
  constructor(detail: string) {
    super(detail);
    this.name = "DaemonNotReadyError";
  }
}

export interface StartedDaemon {
  exited: Promise<void>;
}

export interface LinkDeps {
  connect       : (expect: { browser: string; mode: string }) => Promise<IpcClient>;
  startDaemon   : () => Promise<StartedDaemon>;
  sleep         : (ms: number) => Promise<void>;
  now           : () => number;
  logFile       : string;
  startTimeoutMs: number;
  pollIntervalMs: number;
}

export interface LinkConfig {
  browser  : string;
  mode     : string;
  isolated?: boolean;
}

const MAX_STARTS = 3;

function isUnreachable(error: unknown): boolean {
  return error instanceof DaemonNotRunningError || error instanceof IpcClosedError;
}

export class DaemonLink {
  private client      : IpcClient | undefined;
  private sessionOpen = false;
  private establishing: Promise<IpcClient> | undefined;
  private closed = false;

  constructor(
    private readonly config: LinkConfig,
    private readonly deps: LinkDeps,
  ) {}

  async request(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<unknown> {
    const client = await this.ready();

    return client.request(method, params, options);
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;

    this.client = undefined;
    this.sessionOpen = false;
    await client?.close();
    await this.establishing?.catch(() => undefined);
  }

  ready(): Promise<IpcClient> {
    if (this.closed) return Promise.reject(new IpcClosedError("the link was closed"));
    if (this.client && !this.client.closed && this.sessionOpen) return Promise.resolve(this.client);

    this.establishing ??= this.establish().finally(() => {
      this.establishing = undefined;
    });

    return this.establishing;
  }

  private async establish(): Promise<IpcClient> {
    if (!this.client || this.client.closed) {
      this.sessionOpen = false;
      const connected = await this.connectOrStart();

      if (this.closed) {
        await connected.close();

        throw new IpcClosedError("the link was closed");
      }

      this.client = connected;
    }

    const client = this.client;

    try {
      await this.openSession(client);
    } catch (error) {
      if (!(error instanceof DaemonNotReadyError)) {
        if (this.client === client) this.client = undefined;

        await client.close();
      }

      throw error;
    }

    if (this.closed) {
      await client.close();

      throw new IpcClosedError("the link was closed");
    }

    this.sessionOpen = true;

    return client;
  }

  private async openSession(client: IpcClient): Promise<void> {
    const deadline = this.deps.now() + this.deps.startTimeoutMs;

    for (;;) {
      try {
        await client.request("session.open", { isolated: this.config.isolated ?? false });

        return;
      } catch (error) {
        if (!(error instanceof RpcError) || error.code !== ErrorCode.browserNotReady) throw error;

        const status = await this.status(client);

        if (status?.state !== "starting" || this.deps.now() >= deadline) {
          throw new DaemonNotReadyError(error.message);
        }

        await this.deps.sleep(this.deps.pollIntervalMs);
      }
    }
  }

  private async status(client: IpcClient): Promise<{ state: string } | undefined> {
    try {
      const status = await client.request("daemon.status");

      return typeof (status as { state?: unknown })?.state === "string"
        ? (status as { state: string })
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async start(): Promise<StartedDaemon> {
    try {
      return await this.deps.startDaemon();
    } catch (error) {
      throw new DaemonError(
        `Could not start the daemon (${error instanceof Error ? error.message : String(error)}). See ${this.deps.logFile} for its messages.`,
      );
    }
  }

  private async connectOrStart(): Promise<IpcClient> {
    const expect = { browser: this.config.browser, mode: this.config.mode };

    try {
      return await this.deps.connect(expect);
    } catch (error) {
      if (!isUnreachable(error)) throw error;
    }

    let exited = false;
    const watch = (started: StartedDaemon) => {
      exited = false;
      void started.exited.then(
        () => {
          exited = true;
        },
        () => {
          exited = true;
        },
      );
    };
    const first = await this.start();

    watch(first);
    let starts = 1;
    const deadline = this.deps.now() + this.deps.startTimeoutMs;

    while (this.deps.now() < deadline) {
      await this.deps.sleep(this.deps.pollIntervalMs);

      try {
        return await this.deps.connect(expect);
      } catch (error) {
        if (!isUnreachable(error)) throw error;
      }

      if (exited && starts < MAX_STARTS) {
        watch(await this.start());
        starts += 1;
      }
    }

    throw new DaemonError(
      `The daemon did not start within ${this.deps.startTimeoutMs} ms. See ${this.deps.logFile} for its messages.`,
    );
  }
}
