import { type AttachEndpoint, attachBrowser, runningInProfile } from "../browser/attach.js";
import { BrowserLaunchError, launchManaged } from "../browser/launch.js";
import { CdpClient } from "../cdp/index.js";
import type { Config } from "../config/index.js";
import { CdpBackend } from "./cdp-backend.js";
import { Daemon } from "./daemon.js";
import { AlreadyRunningError } from "./errors.js";
import { daemonIdentity } from "./identity.js";
import { currentLayout, type DaemonLayout } from "./layout.js";
import { acquireInstance } from "./lock.js";
import { describeError, logDaemon } from "./log.js";
import { realInstanceIO } from "./socket-io.js";
import { ensureToken, readToken } from "./token.js";

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export type StopReason = "requested" | "idle" | "browser_disconnected" | "failed";

export interface DaemonOutcome {
  reason: StopReason;
  error?: Error;
}

export interface RunningDaemon {
  done: Promise<DaemonOutcome>;
  stop(): Promise<DaemonOutcome>;
}

export interface BrowserHandle {
  client: CdpClient;
  stop(): Promise<void>;
}

export interface ConnectHooks {
  onWaiting(message: string): void;
}

export type BrowserConnector = (
  config: Config,
  hooks: ConnectHooks,
  signal: AbortSignal,
) => Promise<BrowserHandle>;

export interface RunDeps {
  layout         : DaemonLayout;
  connectBrowser : BrowserConnector;
  idleTimeoutMs  : number;
  helloTimeoutMs?: number;
  probe?         : (path: string) => Promise<"alive" | "stale">;
}

export function approvalMessage(): string {
  return "Connecting to Chrome. If Chrome asks whether to allow remote debugging, click Allow in the browser window.";
}

export interface ConnectorDeps {
  launch     : typeof launchManaged;
  attach     : typeof attachBrowser;
  findRunning: (profileDir: string, debugPort: number) => Promise<AttachEndpoint | undefined>;
  connect    : (url: string) => Promise<CdpClient>;
}

const HEADLESS_AGENT = /HeadlessChrome/;

const defaultConnectorDeps: ConnectorDeps = {
  launch     : launchManaged,
  attach     : attachBrowser,
  findRunning: (profileDir, debugPort) => runningInProfile(profileDir, debugPort),
  connect    : (url) => CdpClient.connect({ url }),
};

async function isHeadless(client: CdpClient): Promise<boolean | undefined> {
  const version = await client.send("Browser.getVersion").catch(() => undefined);
  const agent = (version as { userAgent?: unknown } | undefined)?.userAgent;

  return typeof agent === "string" ? HEADLESS_AGENT.test(agent) : undefined;
}

// Reuses a browser left on the managed profile, for example by a daemon that was killed.
// The daemon never closes a browser it did not launch itself.
async function adoptManaged(
  config: Config,
  deps: ConnectorDeps,
): Promise<BrowserHandle | undefined> {
  const running = await deps
    .findRunning(config.profileDir, config.debugPort)
    .catch(() => undefined);

  if (!running) return undefined;

  const client = await deps.connect(running.webSocketUrl).catch(() => undefined);

  if (!client) return undefined;

  const headless = await isHeadless(client);

  if (headless === config.headless) {
    logDaemon(`Reusing the managed browser that already runs on port ${running.port}.`);

    return { client, stop: () => client.close() };
  }

  await client.close();

  if (headless === undefined) return undefined;

  throw new BrowserLaunchError(
    `A browser already runs on the managed profile ${config.profileDir} ${headless ? "in headless mode" : "with a window"}, but headless is ${String(config.headless)}. ` +
      `Close that browser or set headless to ${String(headless)}.`,
  );
}

async function connectManaged(config: Config, deps: ConnectorDeps): Promise<BrowserHandle> {
  const adopted = await adoptManaged(config, deps);

  if (adopted) return adopted;

  const launched = await deps.launch(config);

  try {
    const client = await deps.connect(launched.webSocketUrl);

    return {
      client,
      stop: async () => {
        await client.close();
        await launched.stop();
      },
    };
  } catch (error) {
    await launched.stop().catch(() => undefined);

    throw error;
  }
}

export function createConnector(overrides: Partial<ConnectorDeps> = {}): BrowserConnector {
  const deps: ConnectorDeps = { ...defaultConnectorDeps, ...overrides };

  return async (config, hooks, signal) => {
    if (config.mode === "managed") return connectManaged(config, deps);

    const endpoint = await deps.attach(config, { onWaiting: hooks.onWaiting }, signal);

    if (endpoint.source === "port-file") hooks.onWaiting(approvalMessage());

    const client = await deps.connect(endpoint.webSocketUrl);

    return { client, stop: () => client.close() };
  };
}

export const connectBrowser: BrowserConnector = createConnector();

async function quietly(what: string, action: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await action();
  } catch (error) {
    logDaemon(`could not ${what}: ${describeError(error)}`);
  }
}

export async function runDaemon(
  config: Config,
  overrides: Partial<RunDeps> = {},
): Promise<RunningDaemon> {
  const deps: RunDeps = {
    layout       : currentLayout(),
    connectBrowser,
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    ...overrides,
  };
  const { layout } = deps;

  if (layout.platform !== "win32" && (await readToken(layout.tokenFile)) === undefined) {
    const probe = deps.probe ?? realInstanceIO.probe;
    const options = layout.instance("");

    if ((await probe(options.socketPath)) === "alive") {
      throw new AlreadyRunningError(options.socketPath);
    }
  }

  const token = await ensureToken(layout.tokenFile, layout.platform, layout.uid);
  const controller = new AbortController();
  let stopping: Promise<DaemonOutcome> | undefined;
  let browser: BrowserHandle | undefined;
  let finish: (outcome: DaemonOutcome) => void = () => undefined;
  const done = new Promise<DaemonOutcome>((resolve) => {
    finish = resolve;
  });

  const daemon = new Daemon({
    token,
    allowFocus    : config.allowFocus,
    identity      : daemonIdentity(config),
    helloTimeoutMs: deps.helloTimeoutMs,
    idleTimeoutMs : deps.idleTimeoutMs,
    onIdle        : () => void stop("idle"),
  });
  const instance = await acquireInstance(layout.instance(token), daemon.accept);

  const stop = (reason: StopReason, error?: Error): Promise<DaemonOutcome> => {
    stopping ??= (async () => {
      controller.abort();
      await quietly("close the sessions", () => daemon.shutdown());
      await quietly("stop the browser", () => browser?.stop());
      await quietly("release the daemon socket", () => instance.release());
      const outcome: DaemonOutcome = error ? { reason, error } : { reason };

      finish(outcome);

      return outcome;
    })();

    return stopping;
  };

  daemon.armIdle();

  void (async () => {
    try {
      const handle = await deps.connectBrowser(
        config,
        { onWaiting: (message) => daemon.setWaiting(message) },
        controller.signal,
      );

      if (stopping) {
        await quietly("stop the browser", () => handle.stop());

        return;
      }

      browser = handle;
      const created = await CdpBackend.create(handle.client);

      if (stopping) return;

      created.onDisconnected(() => {
        if (stopping) return;

        logDaemon("the browser disconnected, stopping the daemon");
        void stop("browser_disconnected");
      });
      daemon.setBackend(created);
    } catch (error) {
      if (stopping) return;

      logDaemon(`could not reach the browser: ${describeError(error)}`);
      await stop("failed", error instanceof Error ? error : new Error(String(error)));
    }
  })();

  return { done, stop: () => stop("requested") };
}
