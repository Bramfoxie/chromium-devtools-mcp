import { attachBrowser } from "../browser/attach.js";
import { launchManaged } from "../browser/launch.js";
import { CdpClient } from "../cdp/index.js";
import type { Config } from "../config/index.js";
import { CdpBackend } from "./cdp-backend.js";
import { Daemon } from "./daemon.js";
import { currentLayout, type DaemonLayout } from "./layout.js";
import { acquireInstance } from "./lock.js";
import { describeError, logDaemon } from "./log.js";
import { ensureToken } from "./token.js";

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
  layout: DaemonLayout;
  connectBrowser: BrowserConnector;
  idleTimeoutMs: number;
  helloTimeoutMs?: number;
}

export const connectBrowser: BrowserConnector = async (config, hooks, signal) => {
  if (config.mode === "managed") {
    const launched = await launchManaged(config);
    try {
      const client = await CdpClient.connect({ url: launched.webSocketUrl });
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
  const endpoint = await attachBrowser(config, { onWaiting: hooks.onWaiting }, signal);
  const client = await CdpClient.connect({ url: endpoint.webSocketUrl });
  return { client, stop: () => client.close() };
};

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
    layout: currentLayout(),
    connectBrowser,
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    ...overrides,
  };
  const { layout } = deps;
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
    allowFocus: config.allowFocus,
    identity: { browser: config.browser, mode: config.mode },
    helloTimeoutMs: deps.helloTimeoutMs,
    idleTimeoutMs: deps.idleTimeoutMs,
    onIdle: () => void stop("idle"),
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
