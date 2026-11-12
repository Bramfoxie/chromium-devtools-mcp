import {
    type AttachEndpoint,
    attachBrowser,
    endpointUnreachableMessage,
    explicitEndpoint,
} from "../browser/attach.js";
import { BrowserLaunchError, launchManaged } from "../browser/launch.js";
import { CdpClient, createWsTransportFactory } from "../cdp/index.js";
import { trafficFile, type TrafficObserver } from "../cdp/traffic-log.js";
import { pathFor, type Config } from "../config/index.js";
import { CdpBackend } from "./cdp-backend.js";
import { Daemon } from "./daemon.js";
import { AlreadyRunningError } from "./errors.js";
import { daemonIdentity } from "./identity.js";
import { artifactsDir, currentLayout, type DaemonLayout } from "./layout.js";
import { acquireInstance } from "./lock.js";
import { describeError, logDaemon } from "../util/log.js";
import { realInstanceIO } from "./socket-io.js";
import { ensureToken, readToken } from "./token.js";
import { findManagedBrowser, prepareManagedProfile, rememberManagedBrowser, type ManagedBindingOptions, type ProfileIdentity } from "./managed-binding.js";
import { abortableSleep } from "../util/sleep.js";

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const APPROVAL_HANDSHAKE_MS = 120_000;
const RETRY_MS = 1000;
const CONNECT_SETTLE_MS = 15_000;

async function settlesWithin(promise: Promise<void>, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
    });

    try {
        await Promise.race([promise, timedOut]);
    } finally {
        clearTimeout(timer);
    }
}

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
    release?(): Promise<void>;
}

export interface ConnectHooks {
    onWaiting(message: string): void;
    managedBinding?: ManagedBindingOptions;
}

export type BrowserConnector = (
    config: Config,
    hooks : ConnectHooks,
    signal: AbortSignal,
) => Promise<BrowserHandle>;

export interface RunDeps {
    layout          : DaemonLayout;
    connectBrowser  : BrowserConnector;
    idleTimeoutMs   : number;
    helloTimeoutMs? : number;
    connectSettleMs?: number;
    probe?          : (path: string) => Promise<"alive" | "stale">;
}

export function approvalMessage(): string {
    return "Connecting to Chrome. If Chrome asks whether to allow remote debugging, click Allow in the browser window.";
}

export interface ConnectorDeps {
    launch     : typeof launchManaged;
    attach     : typeof attachBrowser;
    findRunning: (
        profileDir: string, config: Config, options: ManagedBindingOptions | undefined,
    ) => Promise<AttachEndpoint | undefined>;
    remember: (
        profileDir: string, endpoint: string, config: Config,
        options: ManagedBindingOptions, identity: ProfileIdentity,
    ) => Promise<void>;
    prepareProfile: typeof prepareManagedProfile;
    connect: (
        url: string, handshakeMs?: number, signal?: AbortSignal, traffic?: TrafficObserver,
    ) => Promise<CdpClient>;
    sleep       : (ms: number, signal?: AbortSignal) => Promise<void>;
    handshakeMs?: number;
    retryMs?    : number;
}

const HEADLESS_AGENT = /HeadlessChrome/;

const defaultConnectorDeps: ConnectorDeps = {
    launch     : launchManaged,
    attach     : attachBrowser,
    findRunning: (profileDir, config, options) => options === undefined
        ? Promise.resolve(undefined) : findManagedBrowser(profileDir, config, options),
    remember: (profileDir, endpoint, config, options, identity) =>
        rememberManagedBrowser(profileDir, endpoint, config, options, identity),
    prepareProfile: prepareManagedProfile,
    connect       : (url, handshakeMs, signal, traffic) =>
        CdpClient.connect({
            url,
            signal,
            traffic,
            ...(handshakeMs === undefined
                ? {}
                : { createTransport: createWsTransportFactory(handshakeMs) }),
        }),
    sleep: abortableSleep,
};

async function isHeadless(client: CdpClient): Promise<boolean | undefined> {
    const version = await client.send("Browser.getVersion").catch(() => undefined);
    const agent = (version as { userAgent?: unknown } | undefined)?.userAgent;

    return typeof agent === "string" ? HEADLESS_AGENT.test(agent) : undefined;
}

async function closeLeftoverPages(client: CdpClient): Promise<void> {
    const result = await client.send("Target.getTargets").catch(() => undefined);
    const infos = (result as { targetInfos?: unknown } | undefined)?.targetInfos;

    if (!Array.isArray(infos)) return;

    await Promise.all(
        infos.map(async (info: { type?: unknown; targetId?: unknown }) => {
            if (info.type !== "page" || typeof info.targetId !== "string") return;

            await client.send("Target.closeTarget", { targetId: info.targetId }).catch(() => undefined);
        }),
    );
}

// Reuses a browser left on the managed profile; never closes it.
async function adoptManaged(
    config : Config,
    deps   : ConnectorDeps,
    signal : AbortSignal,
    traffic: TrafficObserver | undefined,
    binding: ManagedBindingOptions | undefined,
): Promise<BrowserHandle | undefined> {
    const running = await deps
        .findRunning(config.profileDir, config, binding)
        .catch(() => undefined);

    if (!running) return undefined;

    const client = await deps
        .connect(running.webSocketUrl, undefined, signal, traffic)
        .catch(() => undefined);

    if (!client) return undefined;

    const headless = await isHeadless(client);

    if (headless === config.headless) {
        const verified = await deps.findRunning(config.profileDir, config, binding)
            .catch(() => undefined);

        if (verified?.webSocketUrl !== running.webSocketUrl) {
            await client.close();

            return undefined;
        }

        logDaemon(`Reusing the managed browser that already runs on port ${running.port}.`);
        if (config.headless) await closeLeftoverPages(client);

        return { client, stop: () => client.close() };
    }

    await client.close();

    if (headless === undefined) return undefined;

    throw new BrowserLaunchError(
        `A browser already runs on the managed profile ${config.profileDir} ${headless ? "in headless mode" : "with a window"}, but headless is ${String(config.headless)}. ` +
      `Close that browser or set headless to ${String(headless)}.`,
    );
}

async function connectManaged(
    config : Config,
    deps   : ConnectorDeps,
    signal : AbortSignal,
    traffic: TrafficObserver | undefined,
    binding: ManagedBindingOptions | undefined,
): Promise<BrowserHandle> {
    const adopted = await adoptManaged(config, deps, signal, traffic, binding);

    if (adopted) return adopted;

    logDaemon(`Starting a managed browser on ${config.profileDir}.`);
    const identity = binding === undefined ? undefined : await deps
        .prepareProfile(config.profileDir)
        .catch(() => {
            logDaemon("could not identify the managed profile; a later daemon may need the browser to be closed");

            return undefined;
        });
    const launched = await deps.launch(config, {}, signal);

    try {
        const client = await deps.connect(launched.webSocketUrl, undefined, signal, traffic);

        if (binding !== undefined && identity !== undefined) {
            await deps.remember(config.profileDir, launched.webSocketUrl, config, binding, identity)
                .catch(() => logDaemon(
                    "could not save the managed browser identity; a later daemon may need the browser to be closed",
                ));
        }

        return {
            client,
            stop: async () => {
                await client.close();
                await launched.stop();
            },
            ...(config.headless
                ? {}
                : {
                    release: async () => {
                        await client.close();
                        launched.release();
                    },
                }),
        };
    } catch (error) {
        await launched.stop().catch(() => undefined);

        throw error;
    }
}

export function createConnector(overrides: Partial<ConnectorDeps> = {}): BrowserConnector {
    const deps: ConnectorDeps = { ...defaultConnectorDeps, ...overrides };

    return async (config, hooks, signal) => {
        const traffic = config.cdpLog === undefined ? undefined : trafficFile(config.cdpLog);

        if (config.mode === "managed") return connectManaged(config, deps, signal, traffic, hooks.managedBinding);

        let reportedUnreachable = false;

        for (;;) {
            const endpoint = config.wsEndpoint === undefined
                ? await deps.attach(config, { onWaiting: hooks.onWaiting }, signal)
                : explicitEndpoint(config.wsEndpoint);

            if (endpoint.source === "port-file") hooks.onWaiting(approvalMessage());

            logDaemon(`Connecting to Chrome on port ${endpoint.port}.`);

            try {
                const budget = deps.handshakeMs ?? APPROVAL_HANDSHAKE_MS;
                const client = await deps.connect(endpoint.webSocketUrl, budget, signal, traffic);

                logDaemon(`Connected to Chrome on port ${endpoint.port}.`);

                return { client, stop: () => client.close() };
            } catch (error) {
                if (signal.aborted) throw error;

                if (endpoint.source === "ws-endpoint" && !reportedUnreachable) {
                    reportedUnreachable = true;
                    hooks.onWaiting(endpointUnreachableMessage());
                }

                logDaemon(`could not connect to the browser yet, retrying: ${describeError(error)}`);
                await deps.sleep(deps.retryMs ?? RETRY_MS, signal);
            }
        }
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
    config   : Config,
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
    let connecting: Promise<void> = Promise.resolve();
    let finish: (outcome: DaemonOutcome) => void = () => undefined;
    const done = new Promise<DaemonOutcome>((resolve) => {
        finish = resolve;
    });

    const daemon = new Daemon({
        token,
        allowFocus    : config.allowFocus,
        downloadsRoot : artifactsDir(layout),
        platform      : layout.platform,
        identity      : daemonIdentity(config),
        helloTimeoutMs: deps.helloTimeoutMs,
        idleTimeoutMs : deps.idleTimeoutMs,
        onIdle        : () => void stop("idle"),
        onStop        : () => void stop("requested"),
    });
    const instance = await acquireInstance(layout.instance(token), daemon.accept);

    const stop = (reason: StopReason, error?: Error): Promise<DaemonOutcome> => {
        stopping ??= (async () => {
            controller.abort();
            if (reason === "failed" && error) await daemon.announceFailure(error.message);

            await quietly("close the sessions", () => daemon.shutdown());
            await quietly("wait for the browser connection", () =>
                settlesWithin(connecting, deps.connectSettleMs ?? CONNECT_SETTLE_MS));
            await quietly("stop the browser", () =>
                reason === "idle" && browser?.release ? browser.release() : browser?.stop(),
            );
            await quietly("release the daemon socket", () => instance.release());
            const outcome: DaemonOutcome = error ? { reason, error } : { reason };

            finish(outcome);

            return outcome;
        })();

        return stopping;
    };

    daemon.armIdle();

    connecting = (async () => {
        try {
            const handle = await deps.connectBrowser(
                config,
                {
                    onWaiting     : (message) => daemon.setWaiting(message),
                    managedBinding: {
                        directory: pathFor(layout.platform).join(
                            pathFor(layout.platform).dirname(layout.tokenFile), "managed-browsers",
                        ),
                        platform: layout.platform,
                        uid     : layout.uid,
                    },
                },
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

            void stop("failed", error instanceof Error ? error : new Error(String(error)));
        }
    })();

    return { done, stop: () => stop("requested") };
}
