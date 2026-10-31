import { readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathFor } from "../browser/platform-path.js";
import type { Config } from "../config/index.js";
import {
  connectToDaemon,
  currentLayout,
  DaemonError,
  daemonIdentity,
  type DaemonLayout,
} from "../daemon/index.js";
import { describeError, logDaemon } from "../daemon/log.js";
import { DaemonLink, type LinkDeps } from "./daemon-link.js";
import { spawnDaemonProcess } from "./spawn-daemon.js";

const SERVER_NAME = "chromium-devtools-mcp";
const START_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

export interface RunningMcp {
  done: Promise<void>;
  stop(): Promise<void>;
}

export interface McpOptions {
  link?   : DaemonLink;
  stdin?  : Readable;
  stdout? : Writable;
  version?: string;
}

export function packageVersion(): string {
  const file = fileURLToPath(new URL("../../package.json", import.meta.url));
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const version = (parsed as { version?: unknown }).version;

  if (typeof version !== "string") throw new DaemonError("package.json has no version");

  return version;
}

export function daemonLogFile(layout: DaemonLayout): string {
  const p = pathFor(layout.platform);

  return p.join(p.dirname(layout.tokenFile), "daemon.log");
}

export function createDaemonLink(config: Config, flags: string[]): DaemonLink {
  const layout = currentLayout();
  const logFile = daemonLogFile(layout);
  const deps: LinkDeps = {
    connect    : (expect) => connectToDaemon({ clientName: SERVER_NAME, expect, layout }),
    startDaemon: () =>
      spawnDaemonProcess({
        execPath: process.execPath,
        script  : fileURLToPath(new URL("../cli.js", import.meta.url)),
        flags,
        logFile,
        platform: layout.platform,
        uid     : layout.uid,
      }),
    sleep         : (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now           : () => Date.now(),
    logFile,
    startTimeoutMs: START_TIMEOUT_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
  };

  return new DaemonLink({ identity: daemonIdentity(config) }, deps);
}

export function createMcpServer(version: string): McpServer {
  return new McpServer({ name: SERVER_NAME, version });
}

export async function runMcpServer(
  config: Config,
  flags: string[],
  options: McpOptions = {},
): Promise<RunningMcp> {
  const link = options.link ?? createDaemonLink(config, flags);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const server = createMcpServer(options.version ?? packageVersion());
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let stopping: Promise<void> | undefined;
  let begun = false;
  const stop = (): Promise<void> => {
    if (begun) return stopping ?? Promise.resolve();

    begun = true;
    stopping = (async () => {
      stdin.off("end", onInputEnd);
      stdin.off("close", onInputEnd);

      try {
        await server.close();
      } catch (error) {
        logDaemon(`could not close the MCP server: ${describeError(error)}`);
      }

      try {
        await link.close();
      } catch (error) {
        logDaemon(`could not close the daemon link: ${describeError(error)}`);
      }

      finish();
    })();

    return stopping;
  };
  const onInputEnd = () => void stop();

  server.server.onclose = () => void stop();
  stdin.once("end", onInputEnd);
  stdin.once("close", onInputEnd);
  await server.connect(new StdioServerTransport(stdin, stdout));

  return { done, stop };
}
