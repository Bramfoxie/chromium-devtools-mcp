import { spawn as nodeSpawn } from "node:child_process";
import type { Socket } from "node:net";
import { isValidWsEndpoint, type Config } from "../config/index.js";
import { type BrowserName, findBrowserExecutable } from "./discovery.js";
import { messageOf } from "../util/message-of.js";
import { AppError } from "../util/app-error.js";

const LISTENING_PATTERN = /DevTools listening on (ws:\/\/\S+)\r?\n/g;
const MAX_BUFFERED_STDERR = 64 * 1024;
const DEFAULT_START_TIMEOUT_MS = 45_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
const CANCELLED_LAUNCH = "The browser launch was cancelled before remote debugging was ready.";

export type ManagedConfig = Pick<Config, "browser" | "headless" | "profileDir" | "debugPort">;

export interface ChildHandle {
    kill(signal: "SIGTERM" | "SIGKILL"): boolean;
    detach(): void;
    onStderr(handler: (chunk: string) => void): void;
    onExit(handler: (reason: string) => void): void;
    onError(handler: (message: string) => void): void;
}

export interface LaunchDeps {
    findExecutable: (browser: BrowserName) => string;
    spawn         : (command: string, args: string[]) => ChildHandle;
    startTimeoutMs: number;
    stopGraceMs   : number;
}

export interface ManagedBrowser {
    readonly port        : number;
    readonly webSocketUrl: string;
    stop(): Promise<void>;
    release(): void;
}

export class BrowserLaunchError extends AppError {}

export function buildLaunchArgs(config: ManagedConfig): string[] {
    const args = [
        `--remote-debugging-port=${config.debugPort}`,
        `--user-data-dir=${config.profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
    ];

    if (config.headless) args.push("--headless=new");

    return args;
}

export function parseListeningUrl(
    output       : string,
    expectedPort?: number,
): { port: number; webSocketUrl: string } | undefined {
    for (const match of output.matchAll(LISTENING_PATTERN)) {
        const webSocketUrl = match[1];

        if (webSocketUrl === undefined || !isValidWsEndpoint(webSocketUrl)) continue;

        const port = Number(new URL(webSocketUrl).port);

        if (port > 0 && (expectedPort === undefined || port === expectedPort)) {
            return { port, webSocketUrl };
        }
    }

    return undefined;
}

export function spawnProcess(command: string, args: string[]): ChildHandle {
    const child = nodeSpawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });

    return {
        kill  : (signal) => child.kill(signal),
        detach: () => {
            (child.stderr as Socket).unref();
            child.unref();
        },
        onStderr: (handler) => {
            child.stderr.setEncoding("utf8");
            child.stderr.on("data", handler);
        },
        onExit: (handler) => {
            child.once("exit", (code, signal) =>
                handler(signal ? `terminated by ${signal}` : `exited with code ${code}`),
            );
        },
        onError: (handler) => {
            child.on("error", (error) => handler(error.message));
        },
    };
}

const defaultDeps: LaunchDeps = {
    findExecutable: (browser) => findBrowserExecutable(browser),
    spawn         : spawnProcess,
    startTimeoutMs: DEFAULT_START_TIMEOUT_MS,
    stopGraceMs   : DEFAULT_STOP_GRACE_MS,
};

export async function launchManaged(
    config   : ManagedConfig,
    overrides: Partial<LaunchDeps> = {},
    signal?  : AbortSignal,
): Promise<ManagedBrowser> {
    const deps: LaunchDeps = { ...defaultDeps, ...overrides };

    if (signal?.aborted) throw new BrowserLaunchError(CANCELLED_LAUNCH);

    const executable = deps.findExecutable(config.browser);

    if (signal?.aborted) throw new BrowserLaunchError(CANCELLED_LAUNCH);

    const startFailure = (detail: string) =>
        new BrowserLaunchError(
            `failed to start ${executable}: ${detail}. Check that the file exists and is executable.`,
        );
    let child: ChildHandle;

    try {
        child = deps.spawn(executable, buildLaunchArgs(config));
    } catch (error) {
        throw startFailure(messageOf(error));
    }

    return new Promise<ManagedBrowser>((resolve, reject) => {
        let settled = false;
        let exitReason: string | undefined;
        let buffered = "";
        let stopping: Promise<void> | undefined;
        let markExited: () => void = () => undefined;
        const exited = new Promise<void>((done) => {
            markExited = done;
        });

        const timer = setTimeout(() => {
            if (settled) return;

            settled = true;
            cleanup();
            child.kill("SIGTERM");
            void terminate(child, exited, deps.stopGraceMs).then(() =>
                reject(
                    new BrowserLaunchError(
                        `${config.browser} did not expose remote debugging within ${deps.startTimeoutMs} ms. ` +
              `Check that the profile directory ${config.profileDir} is writable${config.debugPort === 0 ? "" : ` and that port ${config.debugPort} is free`}.`,
                    ),
                ),
            );
        }, deps.startTimeoutMs);

        const onAbort = () => {
            if (settled) return;

            settled = true;
            cleanup();
            child.kill("SIGTERM");
            void terminate(child, exited, deps.stopGraceMs).then(() =>
                reject(new BrowserLaunchError(CANCELLED_LAUNCH)),
            );
        };
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };

        const stop = () =>
            (stopping ??= (async () => {
                if (exitReason !== undefined) return;

                child.kill("SIGTERM");
                await terminate(child, exited, deps.stopGraceMs);
            })());

        child.onError((message) => {
            if (settled) return;

            settled = true;
            cleanup();
            markExited();
            reject(startFailure(message));
        });

        child.onExit((reason) => {
            exitReason ??= reason;
            markExited();
            if (settled) return;

            settled = true;
            cleanup();
            reject(
                new BrowserLaunchError(
                    `${config.browser} ${reason} before remote debugging was ready. ` +
            `Another browser instance may already use the profile ${config.profileDir}${config.debugPort === 0 ? "" : ` or the port ${config.debugPort}`}: close it or set another profileDir${config.debugPort === 0 ? "" : " or debugPort"}.`,
                ),
            );
        });

        if (!settled) {
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) onAbort();
        }

        child.onStderr((chunk) => {
            if (settled) return;

            buffered = (buffered + chunk).slice(-MAX_BUFFERED_STDERR);
            const endpoint = parseListeningUrl(
                buffered, config.debugPort === 0 ? undefined : config.debugPort,
            );

            if (!endpoint) return;

            settled = true;
            buffered = "";
            cleanup();
            resolve({ ...endpoint, stop, release: () => child.detach() });
        });
    });
}

async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
    });
    const result = await Promise.race([promise.then(() => true as const), timedOut]);

    clearTimeout(timer);

    return result;
}

async function terminate(child: ChildHandle, exited: Promise<void>, graceMs: number) {
    if (await settlesWithin(exited, graceMs)) return;

    child.kill("SIGKILL");
    await settlesWithin(exited, graceMs);
}
