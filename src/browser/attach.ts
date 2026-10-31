import { lstat, readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { pathFor, type Config } from "../config/index.js";
import { BROWSERS, type BrowserName, type DiscoveryContext } from "./browsers.js";

const PORT_FILE_NAME = "DevToolsActivePort";
const BROWSER_PATH_PREFIX = "/devtools/browser/";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_VERSION_BYTES = 64 * 1024;
const VERSION_TIMEOUT_MS = 1000;

export type EndpointSource = "port-file" | "debug-port";

export interface AttachEndpoint {
    port        : number;
    webSocketUrl: string;
    source      : EndpointSource;
}

export type AttachConfig = Pick<Config, "browser" | "debugPort">;

export interface AttachDeps {
    context       : DiscoveryContext;
    readFile      : (file: string) => Promise<string | undefined>;
    hasFile       : (file: string) => Promise<boolean>;
    isPortOpen    : (port: number, signal?: AbortSignal) => Promise<boolean>;
    fetchVersion  : (port: number, signal?: AbortSignal) => Promise<unknown>;
    sleep         : (ms: number, signal?: AbortSignal) => Promise<void>;
    log           : (message: string) => void;
    onWaiting     : (instructions: string) => void;
    pollIntervalMs: number;
}

export class AttachError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AttachError";
    }
}

export function browserUserDataDir(browser: BrowserName, context: DiscoveryContext): string {
    return BROWSERS[browser].userDataDir(context);
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

async function endpointInDir(
    deps   : Pick<AttachDeps, "context" | "readFile" | "isPortOpen">,
    dir    : string,
    signal?: AbortSignal,
): Promise<AttachEndpoint | undefined> {
    let content: string | undefined;

    try {
        content = await deps.readFile(pathFor(deps.context.platform).join(dir, PORT_FILE_NAME));
    } catch {
        return undefined;
    }

    const parsed = content === undefined ? undefined : parseActivePortFile(content);

    // The inspect server has no HTTP endpoints; the port file is the only URL source.
    if (parsed && (await deps.isPortOpen(parsed.port, signal).catch(() => false))) {
        return { ...parsed, source: "port-file" };
    }

    return undefined;
}

async function portFileEndpoint(
    deps   : AttachDeps,
    browser: BrowserName,
    signal?: AbortSignal,
): Promise<AttachEndpoint | undefined> {
    return endpointInDir(deps, browserUserDataDir(browser, deps.context), signal);
}

// Finds a browser already running on the user data directory.
export async function runningInProfile(
    dir      : string,
    debugPort: number,
    overrides: Partial<
        Pick<AttachDeps, "context" | "readFile" | "hasFile" | "isPortOpen" | "fetchVersion">
    > = {},
): Promise<AttachEndpoint | undefined> {
    const deps: AttachDeps = { ...defaultAttachDeps(), ...overrides };

    const fromFile = await endpointInDir(deps, dir);

    if (fromFile) return fromFile;

    if (!(await profileLocked(deps, dir))) return undefined;

    let version: unknown;

    try {
        version = await deps.fetchVersion(debugPort);
    } catch {
        return undefined;
    }

    const webSocketUrl = browserWebSocketUrl(version, debugPort);

    return webSocketUrl ? { port: debugPort, webSocketUrl, source: "debug-port" } : undefined;
}

// A lock file proves a running browser holds the profile.
async function profileLocked(deps: AttachDeps, dir: string): Promise<boolean> {
    const name = deps.context.platform === "win32" ? "lockfile" : "SingletonSocket";

    return deps.hasFile(pathFor(deps.context.platform).join(dir, name));
}

export async function resolveAttachEndpoint(
    config : AttachConfig,
    deps   : AttachDeps,
    signal?: AbortSignal,
): Promise<AttachEndpoint | undefined> {
    const fromFile = await portFileEndpoint(deps, config.browser, signal);

    if (fromFile) return fromFile;

    let version: unknown;

    try {
        version = await deps.fetchVersion(config.debugPort, signal);
    } catch {
        return undefined;
    }

    const webSocketUrl = browserWebSocketUrl(version, config.debugPort);

    if (webSocketUrl) return { port: config.debugPort, webSocketUrl, source: "debug-port" };

    return undefined;
}

export function setupInstructions(config: AttachConfig): string {
    const spec = BROWSERS[config.browser];

    return [
        `Cannot attach to ${spec.label} yet: remote debugging is not enabled. Waiting until it is.`,
        ...spec.attachSteps(config.debugPort),
    ].join("\n");
}

export async function attachBrowser(
    config   : AttachConfig,
    overrides: Partial<AttachDeps> = {},
    signal?  : AbortSignal,
): Promise<AttachEndpoint> {
    const deps: AttachDeps = { ...defaultAttachDeps(), ...overrides };
    let instructed = false;

    while (!signal?.aborted) {
        const endpoint = await resolveAttachEndpoint(config, deps, signal);

        if (endpoint) {
            deps.log(`Attaching to ${BROWSERS[config.browser].label} on port ${endpoint.port} (${endpoint.source}).`);

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

export async function fileExists(file: string): Promise<boolean> {
    try {
        await lstat(file);

        return true;
    } catch {
        return false;
    }
}

// Probes and fetches use 127.0.0.1 only.
export function probePort(port: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(false);

            return;
        }

        let socket: net.Socket;

        try {
            socket = net.connect({ host: "127.0.0.1", port });
        } catch {
            resolve(false);

            return;
        }

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
    port   : number,
    signal?: AbortSignal,
    timeoutMs = VERSION_TIMEOUT_MS,
): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);

    try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal  : signal ? AbortSignal.any([timeout, signal]) : timeout,
            redirect: "error",
        });

        if (!response.ok) return undefined;

        const declared = Number(response.headers.get("content-length"));

        if (Number.isFinite(declared) && declared > MAX_VERSION_BYTES) return undefined;

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
        context       : { env: process.env, platform: process.platform, homedir: os.homedir() },
        readFile      : readIfExists,
        hasFile       : fileExists,
        isPortOpen    : probePort,
        fetchVersion,
        sleep         : abortableSleep,
        log           : (message) => process.stderr.write(`chromium-devtools-mcp: ${message}\n`),
        onWaiting     : () => undefined,
        pollIntervalMs: 1000,
    };
}
