import { readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathFor, type Config } from "../config/index.js";
import { allTools, registerTools, ToolRuntime } from "../tools/index.js";
import { DaemonAccess } from "./daemon-access.js";
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
const CONNECT_TIMEOUT_MS = 1000;

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

export function readPackageVersion(file: string, read: (file: string) => string): string {
    const version = (JSON.parse(read(file)) as { version?: unknown }).version;

    if (typeof version !== "string") throw new DaemonError(`${file} has no version`);

    return version;
}

export function packageVersion(): string {
    const file = fileURLToPath(new URL("../../package.json", import.meta.url));

    return readPackageVersion(file, (name) => readFileSync(name, "utf8"));
}

export function daemonLogFile(layout: DaemonLayout): string {
    const p = pathFor(layout.platform);

    return p.join(p.dirname(layout.tokenFile), "daemon.log");
}

export function daemonScriptPath(here: string = import.meta.url): string {
    return fileURLToPath(new URL("../cli.js", here));
}

export interface LinkFactoryOptions {
    layout?     : DaemonLayout;
    execPath?   : string;
    script?     : string;
    spawn?      : typeof spawnDaemonProcess;
    sleep?      : (ms: number) => Promise<void>;
    now?        : () => number;
    connect?    : LinkDeps["connect"];
    startDaemon?: LinkDeps["startDaemon"];
    logFile?    : string;
}

export function createDaemonLink(
    config : Config,
    flags  : string[],
    options: LinkFactoryOptions = {},
): DaemonLink {
    const layout = options.layout ?? currentLayout();
    const logFile = options.logFile ?? daemonLogFile(layout);
    const spawn = options.spawn ?? spawnDaemonProcess;
    const deps: LinkDeps = {
        connect: options.connect ??
      ((expect) =>
          connectToDaemon({
              clientName      : SERVER_NAME,
              expect,
              layout,
              connectTimeoutMs: CONNECT_TIMEOUT_MS,
          })),
        startDaemon: options.startDaemon ??
      (() =>
          spawn({
              execPath: options.execPath ?? process.execPath,
              script  : options.script ?? daemonScriptPath(),
              flags,
              logFile,
              platform: layout.platform,
              uid     : layout.uid,
          })),
        sleep:
            options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        now           : options.now ?? (() => Date.now()),
        logFile,
        startTimeoutMs: START_TIMEOUT_MS,
        pollIntervalMs: POLL_INTERVAL_MS,
    };

    return new DaemonLink({ identity: daemonIdentity(config), isolated: config.isolated }, deps);
}

export const SERVER_INSTRUCTIONS =
    "Drive a Chromium browser. Tabs open in the background with new_tab; most tools act on " +
    "the selected tab or on a tab id from list_tabs. Element targets use a uid from a snapshot " +
    "or a CSS selector, never both. Large outputs are truncated with an explicit marker.";

export function createMcpServer(version: string): McpServer {
    const server = new McpServer(
        { name: SERVER_NAME, version },
        { instructions: SERVER_INSTRUCTIONS },
    );

    return server;
}

export interface ToolServerOptions {
    access?: DaemonAccess;
    tools? : typeof allTools;
}

export function registerServerTools(
    server : McpServer,
    config : Config,
    link   : DaemonLink,
    options: ToolServerOptions = {},
): ToolRuntime {
    const access = options.access ?? new DaemonAccess({ link });
    const runtime = new ToolRuntime({ access, config });

    access.on("tab.closed", (params) => {
        const targetId = (params as { targetId?: unknown } | null)?.targetId;

        if (typeof targetId === "string") {
            runtime.tabs.forget(targetId);
            runtime.frames.forget(targetId);
            runtime.focus.forget(targetId);
            runtime.dialogs.forget(targetId);
            void runtime.mock.forget(targetId);
            runtime.emulation.forget(targetId);
        }
    });
    runtime.capture.attach();
    runtime.dialogs.attach();
    runtime.frames.attach();
    runtime.mock.attach();
    access.forgetStaleState(() => {
        runtime.tabs.reset();
        runtime.elements.reset();
        runtime.frames.reset();
        runtime.focus.reset();
        runtime.capture.reset();
        runtime.dialogs.reset();
        void runtime.mock.reset();
        runtime.emulation.reset();
    });
    registerTools({ server, tools: options.tools ?? allTools, runtime });

    return runtime;
}

export async function runMcpServer(
    config : Config,
    flags  : string[],
    options: McpOptions = {},
): Promise<RunningMcp> {
    const link = options.link ?? createDaemonLink(config, flags);
    const stdin = options.stdin ?? process.stdin;
    const stdout = options.stdout ?? process.stdout;
    const server = createMcpServer(options.version ?? packageVersion());

    registerServerTools(server, config, link);
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
        finish = resolve;
    });
    let stopping: Promise<void> | undefined;
    let begun = false;
    const stop = (): Promise<void> => {
        if (begun) return stopping ?? Promise.resolve();

        // Set first: server.close() fires onclose synchronously.
        begun = true;
        stopping = (async () => {
            stdin.off("end", onInputEnd);
            stdin.off("close", onInputEnd);
            stdout.off("error", onOutputError);

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
    const onOutputError = () => void stop();

    server.server.onclose = () => void stop();
    stdin.once("end", onInputEnd);
    stdin.once("close", onInputEnd);
    stdout.once("error", onOutputError);

    try {
        await server.connect(new StdioServerTransport(stdin, stdout));
    } catch (error) {
        await stop();

        throw error;
    }

    return { done, stop };
}
