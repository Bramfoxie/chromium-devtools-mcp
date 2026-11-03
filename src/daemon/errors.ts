export class DaemonError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DaemonError";
    }
}

export function errorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) return undefined;

    const code = (error as { code?: unknown }).code;

    return typeof code === "string" ? code : undefined;
}

export class AlreadyRunningError extends DaemonError {
    constructor(readonly socketPath: string) {
        super(
            `Another chromium-devtools-mcp daemon is already running on ${socketPath}. ` +
        "Connect to it instead of starting a new one.",
        );
        this.name = "AlreadyRunningError";
    }
}

export class ProtocolViolationError extends DaemonError {
    constructor(detail: string) {
        super(`Invalid daemon message: ${detail}.`);
        this.name = "ProtocolViolationError";
    }
}

export class RpcError extends DaemonError {
    constructor(
        readonly code: string,
        message      : string,
    ) {
        super(message);
        this.name = "RpcError";
    }
}

export class IpcTimeoutError extends DaemonError {
    constructor(
        readonly method   : string,
        readonly timeoutMs: number,
    ) {
        super(
            `Daemon request ${method} timed out after ${timeoutMs} ms. Check that the daemon is responsive or raise the timeout.`,
        );
        this.name = "IpcTimeoutError";
    }
}

export class IpcCancelledError extends DaemonError {
    constructor(readonly method: string) {
        super(
            `Daemon request ${method} was cancelled before it completed. The daemon may still run the command.`,
        );
        this.name = "IpcCancelledError";
    }
}

export class IpcClosedError extends DaemonError {
    constructor(detail: string) {
        super(`Daemon connection is closed: ${detail}. Reconnect to the daemon and retry.`);
        this.name = "IpcClosedError";
    }
}

export class DaemonNotRunningError extends DaemonError {
    constructor() {
        super(
            "No chromium-devtools-mcp daemon is running for this user. Start it with the daemon command and try again.",
        );
        this.name = "DaemonNotRunningError";
    }
}

export class DaemonConfigMismatchError extends DaemonError {
    constructor(running: string, expected: string) {
        super(
            `The running daemon uses ${running}, but this client expects ${expected}. Stop the daemon or make both use the same configuration.`,
        );
        this.name = "DaemonConfigMismatchError";
    }
}
