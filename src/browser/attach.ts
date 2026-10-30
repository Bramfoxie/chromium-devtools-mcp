import { readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { type BrowserName, type DiscoveryContext } from "./discovery.js";
import { pathFor } from "./platform-path.js";

const PORT_FILE_NAME = "DevToolsActivePort";
const BROWSER_PATH_PREFIX = "/devtools/browser/";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_VERSION_BYTES = 64 * 1024;
const VERSION_TIMEOUT_MS = 1000;

export type EndpointSource = "port-file" | "debug-port";

export interface AttachEndpoint {
  port: number;
  webSocketUrl: string;
  source: EndpointSource;
}

export interface AttachConfig {
  browser: BrowserName;
  debugPort: number;
}

export interface AttachDeps {
  context: DiscoveryContext;
  readFile: (file: string) => Promise<string | undefined>;
  isPortOpen: (port: number, signal?: AbortSignal) => Promise<boolean>;
  fetchVersion: (port: number, signal?: AbortSignal) => Promise<unknown>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  log: (message: string) => void;
  onWaiting: (instructions: string) => void;
  pollIntervalMs: number;
}

export class AttachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachError";
  }
}

export function browserUserDataDir(
  browser: BrowserName,
  { env, platform, homedir }: DiscoveryContext,
): string | undefined {
  const p = pathFor(platform);
  if (platform === "darwin") {
    const support = p.join(homedir, "Library", "Application Support");
    return browser === "chrome"
      ? p.join(support, "Google", "Chrome")
      : p.join(support, "Arc", "User Data");
  }
  if (browser !== "chrome") return undefined;
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || p.join(homedir, "AppData", "Local");
    return p.join(base, "Google", "Chrome", "User Data");
  }
  const base = env.XDG_CONFIG_HOME || p.join(homedir, ".config");
  return p.join(base, "google-chrome");
}

export function parseActivePortFile(
  content: string,
): { port: number; webSocketUrl: string } | undefined {
  const [portLine, pathLine] = content.split(/\r?\n/);
  const port = Number(portLine?.trim());
  const browserPath = pathLine?.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (!browserPath?.startsWith(BROWSER_PATH_PREFIX)) return undefined;
  return { port, webSocketUrl: `ws://127.0.0.1:${port}${browserPath}` };
}

function browserWebSocketUrl(version: unknown, port: number): string | undefined {
  if (typeof version !== "object" || version === null) return undefined;
  const url = (version as Record<string, unknown>).webSocketDebuggerUrl;
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    const isBrowserSocket =
      parsed.protocol === "ws:" && parsed.pathname.startsWith(BROWSER_PATH_PREFIX);
    const samePort = Number(parsed.port || 80) === port;
    return isBrowserSocket && samePort && LOOPBACK_HOSTS.has(parsed.hostname) ? url : undefined;
  } catch {
    return undefined;
  }
}

async function readPortFile(deps: AttachDeps, file: string): Promise<string | undefined> {
  try {
    return await deps.readFile(file);
  } catch {
    return undefined;
  }
}

export async function resolveAttachEndpoint(
  config: AttachConfig,
  deps: AttachDeps,
  signal?: AbortSignal,
): Promise<AttachEndpoint | undefined> {
  const dir = browserUserDataDir(config.browser, deps.context);
  if (dir) {
    const file = pathFor(deps.context.platform).join(dir, PORT_FILE_NAME);
    const content = await readPortFile(deps, file);
    const parsed = content === undefined ? undefined : parseActivePortFile(content);
    if (parsed && (await deps.isPortOpen(parsed.port, signal))) {
      return { ...parsed, source: "port-file" };
    }
  }
  const version = await deps.fetchVersion(config.debugPort, signal);
  const webSocketUrl = browserWebSocketUrl(version, config.debugPort);
  if (webSocketUrl) return { port: config.debugPort, webSocketUrl, source: "debug-port" };
  return undefined;
}

export function setupInstructions(config: AttachConfig): string {
  const name = config.browser === "chrome" ? "Chrome" : "Arc";
  const lines = [
    `Cannot attach to ${name} yet: remote debugging is not enabled. Waiting until it is.`,
  ];
  if (config.browser === "chrome") {
    lines.push(
      'Option 1 (Chrome 144 or newer): in the Chrome window you want to control, open chrome://inspect/#remote-debugging and turn on "Allow remote debugging for this browser instance". Chrome asks you to approve each connection.',
    );
  }
  lines.push(
    `${config.browser === "chrome" ? "Option 2" : "Option"}: quit ${name} and start it with --remote-debugging-port=${config.debugPort}` +
      (config.browser === "chrome"
        ? " and --user-data-dir pointing to a non-default directory. This uses a separate profile, not your everyday one."
        : "."),
  );
  return lines.join("\n");
}

export async function attachBrowser(
  config: AttachConfig,
  overrides: Partial<AttachDeps> = {},
  signal?: AbortSignal,
): Promise<AttachEndpoint> {
  const deps: AttachDeps = { ...defaultAttachDeps(), ...overrides };
  let instructed = false;
  while (!signal?.aborted) {
    const endpoint = await resolveAttachEndpoint(config, deps, signal);
    if (endpoint) {
      deps.log(`Attaching to ${config.browser} on port ${endpoint.port} (${endpoint.source}).`);
      return endpoint;
    }
    if (!instructed) {
      const instructions = setupInstructions(config);
      deps.log(instructions);
      deps.onWaiting(instructions);
      instructed = true;
    }
    await deps.sleep(deps.pollIntervalMs, signal);
  }
  throw new AttachError("Attach was cancelled before the browser allowed remote debugging.");
}

export async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function probePort(port: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(open);
    };
    const onAbort = () => finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function fetchVersion(
  port: number,
  signal?: AbortSignal,
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      redirect: "error",
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    return text.length > MAX_VERSION_BYTES ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function defaultAttachDeps(): AttachDeps {
  return {
    context: { env: process.env, platform: process.platform, homedir: os.homedir() },
    readFile: readIfExists,
    isPortOpen: probePort,
    fetchVersion,
    sleep: abortableSleep,
    log: (message) => process.stderr.write(`chromium-devtools-mcp: ${message}\n`),
    onWaiting: () => undefined,
    pollIntervalMs: 1000,
  };
}
