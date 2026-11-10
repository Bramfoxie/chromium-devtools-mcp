import { lstat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { BROWSER_PATH_PREFIX, LOOPBACK_HOSTS, pathFor, type Config } from "../config/index.js";
import { BROWSERS, type BrowserName, type DiscoveryContext } from "./browsers.js";
import { readIfExists } from "../util/read-if-exists.js";
import { writeLogLine } from "../util/stderr.js";
import { abortableSleep } from "../util/sleep.js";
import { AppError } from "../util/app-error.js";
import { messageOf } from "../util/message-of.js";

const PORT_FILE_NAME = "DevToolsActivePort";
const MAX_VERSION_BYTES = 64 * 1024;
const VERSION_TIMEOUT_MS = 1000;
const PORT_PROBE_TIMEOUT_MS = 500;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export type EndpointSource = "port-file" | "debug-port" | "ws-endpoint";

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

export class AttachError extends AppError {}

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

export type ProblemReporter = (message: string, deniedFile?: string) => void;

function isAccessDenied(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;

    return code === "EPERM" || code === "EACCES";
}

async function endpointInDir(
    deps      : Pick<AttachDeps, "context" | "readFile" | "isPortOpen">,
    dir       : string,
    signal?   : AbortSignal,
    onProblem?: ProblemReporter,
): Promise<AttachEndpoint | undefined> {
    const file = pathFor(deps.context.platform).join(dir, PORT_FILE_NAME);
    let content: string | undefined;

    try {
        content = await deps.readFile(file);
    } catch (error) {
        const denied = isAccessDenied(error) ? file : undefined;

        onProblem?.(`Cannot read ${file}: ${messageOf(error)}`, denied);

        return undefined;
    }

    if (content === undefined) return undefined;

    const parsed = parseActivePortFile(content);

    if (parsed === undefined) {
        onProblem?.(`${file} does not hold a port and a browser path.`);

        return undefined;
    }

    if (await deps.isPortOpen(parsed.port, signal).catch(() => false)) {
        return { ...parsed, source: "port-file" };
    }

    onProblem?.(`Port ${parsed.port} named in ${file} does not accept connections.`);

    return undefined;
}

async function portFileEndpoint(
    deps      : AttachDeps,
    browser   : BrowserName,
    signal?   : AbortSignal,
    onProblem?: ProblemReporter,
): Promise<AttachEndpoint | undefined> {
    return endpointInDir(deps, browserUserDataDir(browser, deps.context), signal, onProblem);
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
    config    : AttachConfig,
    deps      : AttachDeps,
    signal?   : AbortSignal,
    onProblem?: ProblemReporter,
): Promise<AttachEndpoint | undefined> {
    const fromFile = await portFileEndpoint(deps, config.browser, signal, onProblem);

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

export async function deniedPortFile(
    config   : AttachConfig,
    overrides: Partial<Pick<AttachDeps, "context" | "readFile">> = {},
): Promise<string | undefined> {
    const { context, readFile } = { ...defaultAttachDeps(), ...overrides };
    const dir = browserUserDataDir(config.browser, context);
    const file = pathFor(context.platform).join(dir, PORT_FILE_NAME);

    try {
        await readFile(file);

        return undefined;
    } catch (error) {
        return isAccessDenied(error) ? file : undefined;
    }
}

export function findAttachEndpoint(
    config   : AttachConfig,
    overrides: Partial<AttachDeps> = {},
): Promise<AttachEndpoint | undefined> {
    return resolveAttachEndpoint(config, { ...defaultAttachDeps(), ...overrides });
}

export function explicitEndpoint(webSocketUrl: string): AttachEndpoint {
    return { port: Number(new URL(webSocketUrl).port), webSocketUrl, source: "ws-endpoint" };
}

export function endpointUnreachableMessage(webSocketUrl: string): string {
    return `Cannot connect to ${webSocketUrl} yet. Check that the browser is running with remote debugging and that wsEndpoint is its current address, which changes when the browser restarts. Waiting until it answers.`;
}

export function setupInstructions(config: AttachConfig): string {
    const spec = BROWSERS[config.browser];

    return [
        `Cannot attach to ${spec.label} yet: remote debugging is not enabled. Waiting until it is.`,
        ...spec.attachSteps(config.debugPort),
    ].join("\n");
}

export function accessDeniedFix(platform: NodeJS.Platform): string[] {
    return platform === "darwin"
        ? [
            "macOS blocks apps from reading another app's data. Open System Settings > Privacy & Security > Full Disk Access, turn it on for the app that starts this server (the MCP client or the terminal), then restart that app.",
            "Or start the daemon from a terminal that already has access, then restart the client: npx chromium-devtools-mcp daemon",
        ]
        : ["Check that the current user may read this file and the profile directory that holds it."];
}

export function accessDeniedInstructions(
    config  : AttachConfig,
    file    : string,
    platform: NodeJS.Platform,
): string {
    const label = BROWSERS[config.browser].label;
    const steps = accessDeniedFix(platform);

    return [
        `Cannot attach to ${label} yet: this process is not allowed to read ${file}, so the address of a ${label} with remote debugging is unknown, even if it is running. Waiting until the file can be read.`,
        ...steps,
    ].join("\n");
}

export async function attachBrowser(
    config   : AttachConfig,
    overrides: Partial<AttachDeps> = {},
    signal?  : AbortSignal,
): Promise<AttachEndpoint> {
    const deps: AttachDeps = { ...defaultAttachDeps(), ...overrides };
    let instructed: string | undefined;
    const reported = new Set<string>();
    let deniedFile: string | undefined;
    const onProblem: ProblemReporter = (message, denied) => {
        deniedFile = denied;

        if (reported.has(message)) return;

        reported.add(message);
        deps.log(message);
    };

    while (!signal?.aborted) {
        deniedFile = undefined;

        const endpoint = await resolveAttachEndpoint(config, deps, signal, onProblem);

        if (endpoint) {
            deps.log(`Attaching to ${BROWSERS[config.browser].label} on port ${endpoint.port} (${endpoint.source}).`);

            return endpoint;
        }

        const instructions =
            deniedFile === undefined
                ? setupInstructions(config)
                : accessDeniedInstructions(config, deniedFile, deps.context.platform);

        if (instructions !== instructed) {
            deps.log(instructions);
            deps.onWaiting(instructions);
            instructed = instructions;
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
        socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => finish(false));
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
        pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    };
}
