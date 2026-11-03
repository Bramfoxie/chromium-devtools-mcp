import {
    type DaemonIdentity,
    DaemonError,
    DaemonNotRunningError,
    ErrorCode,
    type IpcClient,
    IpcClosedError,
    IpcTimeoutError,
    RpcError,
} from "../daemon/index.js";

export class DaemonNotReadyError extends DaemonError {
    constructor(detail: string) {
        super(detail);
        this.name = "DaemonNotReadyError";
    }
}

export interface StartedDaemon {
    exited: Promise<void>;
}

export interface LinkDeps {
    connect       : (expect: DaemonIdentity) => Promise<IpcClient>;
    startDaemon   : () => Promise<StartedDaemon>;
    sleep         : (ms: number) => Promise<void>;
    now           : () => number;
    logFile       : string;
    startTimeoutMs: number;
    pollIntervalMs: number;
}

export interface LinkConfig {
    identity : DaemonIdentity;
    isolated?: boolean;
    safety?  : {
        readOnly        : boolean;
        allowedDomains  : string[];
        confirmDangerous: boolean;
    };
}

export type SessionResetHandler = () => void;

const MAX_STARTS = 3;

function isUnreachable(error: unknown): boolean {
    return (
        error instanceof DaemonNotRunningError ||
    error instanceof IpcClosedError ||
    error instanceof IpcTimeoutError
    );
}

export class DaemonLink {
    private client      : IpcClient | undefined;
    private sessionOpen = false;
    private establishing: Promise<IpcClient> | undefined;
    private closed = false;
    private generation = 0;
    private readonly resets = new Set<SessionResetHandler>();

    constructor(
        private readonly config: LinkConfig,
        private readonly deps  : LinkDeps,
    ) {}

    get sessionGeneration(): number {
        return this.generation;
    }

    onSessionReset(handler: SessionResetHandler): () => void {
        this.resets.add(handler);

        return () => void this.resets.delete(handler);
    }

    async request(
        method  : string,
        params? : unknown,
        options?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<unknown> {
        const client = await this.ready();

        return client.request(method, params, options);
    }

    async close(): Promise<void> {
        this.closed = true;
        const client = this.client;

        this.client = undefined;
        this.sessionOpen = false;
        await client?.close();
        await this.establishing?.catch(() => undefined);
    }

    ready(): Promise<IpcClient> {
        if (this.closed) return Promise.reject(new IpcClosedError("the link was closed"));

        if (this.client && !this.client.closed && this.sessionOpen) {
            return Promise.resolve(this.client);
        }

        this.establishing ??= this.establish().finally(() => {
            this.establishing = undefined;
        });

        return this.establishing;
    }

    private async establish(): Promise<IpcClient> {
        if (!this.client || this.client.closed) {
            this.sessionOpen = false;
            const connected = await this.connectOrStart();

            if (this.closed) {
                await connected.close();

                throw new IpcClosedError("the link was closed");
            }

            this.client = connected;
        }

        const client = this.client;

        try {
            await this.openSession(client);
        } catch (error) {
            if (!(error instanceof DaemonNotReadyError)) {
                if (this.client === client) this.client = undefined;

                await client.close();
            }

            if (error instanceof IpcClosedError && !this.closed) {
                if (client.failure) {
                    throw new DaemonError(
                        `The browser could not be started: ${client.failure.replace(/\.$/, "")}. ` +
                            "Check the browser installation, close other windows that use the same profile, or raise the wait." +
                            ` See ${this.deps.logFile} for the daemon messages.`,
                    );
                }

                throw new DaemonError(
                    `The daemon stopped while opening a session. See ${this.deps.logFile} for its messages.`,
                );
            }

            throw error;
        }

        if (this.closed) {
            await client.close();

            throw new IpcClosedError("the link was closed");
        }

        this.sessionOpen = true;
        this.generation += 1;
        this.notifyReset();

        return client;
    }

    private notifyReset(): void {
        for (const handler of [...this.resets]) handler();
    }

    private async openSession(client: IpcClient): Promise<void> {
        const deadline = this.deps.now() + this.deps.startTimeoutMs;

        for (;;) {
            if (this.closed) throw new IpcClosedError("the link was closed");

            try {
                await client.request("session.open", {
                    isolated: this.config.isolated ?? false,
                    ...(this.config.safety === undefined ? {} : { safety: this.config.safety }),
                });

                return;
            } catch (error) {
                const notReady =
                    error instanceof RpcError && error.code === ErrorCode.browserNotReady;

                if (!notReady) throw error;

                const status = await this.status(client);

                const pending = status?.state === "starting" || status?.state === "ready";

                if (!pending || this.deps.now() >= deadline) {
                    throw new DaemonNotReadyError(error.message);
                }

                await this.deps.sleep(this.deps.pollIntervalMs);
                if (this.closed) throw new IpcClosedError("the link was closed");
            }
        }
    }

    private async status(client: IpcClient): Promise<{ state: string } | undefined> {
        let status: unknown;

        try {
            status = await client.request("daemon.status");
        } catch (error) {
            if (error instanceof IpcClosedError || error instanceof IpcTimeoutError) throw error;

            return undefined;
        }

        const state = (status as { state?: unknown } | null)?.state;

        return typeof state === "string" ? { state } : undefined;
    }

    private async start(): Promise<StartedDaemon> {
        try {
            return await this.deps.startDaemon();
        } catch (error) {
            throw new DaemonError(
                `Could not start the daemon (${error instanceof Error ? error.message : String(error)}). See ${this.deps.logFile} for its messages.`,
            );
        }
    }

    private async connectOrStart(): Promise<IpcClient> {
        const expect = this.config.identity;

        try {
            return await this.deps.connect(expect);
        } catch (error) {
            if (!isUnreachable(error)) throw error;
        }

        let exited = false;
        const watch = (started: StartedDaemon) => {
            exited = false;
            void started.exited.then(
                () => {
                    exited = true;
                },
                () => {
                    exited = true;
                },
            );
        };
        const first = await this.start();

        watch(first);
        let starts = 1;
        let lastError: string | undefined;
        const deadline = this.deps.now() + this.deps.startTimeoutMs;

        while (this.deps.now() < deadline) {
            if (this.closed) throw new IpcClosedError("the link was closed");

            await this.deps.sleep(this.deps.pollIntervalMs);
            if (this.closed) throw new IpcClosedError("the link was closed");

            try {
                return await this.deps.connect(expect);
            } catch (error) {
                if (!isUnreachable(error)) throw error;

                lastError = error instanceof Error ? error.message : String(error);
            }

            if (exited && starts < MAX_STARTS) {
                watch(await this.start());
                starts += 1;
            }
        }

        throw new DaemonError(
            `The daemon did not start within ${this.deps.startTimeoutMs} ms. See ${this.deps.logFile} for its messages.` +
        (lastError ? ` Last error: ${lastError}` : ""),
        );
    }
}
