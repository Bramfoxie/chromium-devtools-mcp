import { lstat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { pathFor, type Config } from "../config/index.js";
import { BROWSERS, type BrowserName, type DiscoveryContext } from "./browsers.js";
import { readIfExists } from "../util/read-if-exists.js";
import { writeLogLine } from "../util/stderr.js";
import { abortableSleep } from "../util/sleep.js";

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

    if (debugPort === 0 || !(await profileLocked(deps, dir))) return undefined;

    let version: unknown;

    try {
        version = await deps.fetchVersion(debugPort);
    } catch {
        return undefined;
    }

    const webSocketUrl = browserWebSocketUrl(version, debugPort);

    return webSocketUrl ? { port: debugPort, webSocketUrl, source: "debug-port" } : undefined;
}

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

// Resolves to the parsed JSON, or undefined on any failure; the socket is always destroyed.
export function fetchVersion(
    port   : number,
    signal?: AbortSignal,
    timeoutMs = VERSION_TIMEOUT_MS,
): Promise<unknown> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;
        let request: http.ClientRequest | undefined;
        const finish = (value: unknown) => {
            if (settled) return;

            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            request?.destroy();
            resolve(value);
        };
        const onAbort = () => finish(undefined);
        const timer = setTimeout(() => finish(undefined), timeoutMs);

        if (signal?.aborted) return finish(undefined);

        signal?.addEventListener("abort", onAbort, { once: true });

        try {
            request = http.get(
                {
                    host   : "127.0.0.1",
                    port,
                    path   : "/json/version",
                    agent  : false,
                    headers: { connection: "close" },
                },
                (response) => {
                    const declared = Number(response.headers["content-length"]);

                    const tooLarge = Number.isFinite(declared) && declared > MAX_VERSION_BYTES;

                    if (response.statusCode !== 200 || tooLarge) {
                        finish(undefined);

                        return;
                    }

                    response.on("data", (chunk: Buffer) => {
                        total += chunk.byteLength;

                        if (total > MAX_VERSION_BYTES) finish(undefined);
                        else chunks.push(chunk);
                    });
                    response.on("end", () => {
                        try {
                            finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                        } catch {
                            finish(undefined);
                        }
                    });
                    response.on("error", () => finish(undefined));
                },
            );
            request.on("error", () => finish(undefined));
        } catch {
            finish(undefined);
        }
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
        log           : writeLogLine,
        onWaiting     : () => undefined,
        pollIntervalMs: 1000,
    };
}
