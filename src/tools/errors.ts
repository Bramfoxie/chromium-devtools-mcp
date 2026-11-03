import {
    DaemonConfigMismatchError,
    DaemonError,
    ErrorCode,
    IpcCancelledError,
    IpcClosedError,
    IpcTimeoutError,
    RpcError,
} from "../daemon/index.js";
import { describeError, logDaemon } from "../util/log.js";
import { DaemonNotReadyError, SessionResetError } from "../mcp/index.js";
import { AppError } from "../util/app-error.js";

export class ToolError extends AppError {}

const MAX_ERROR_CHARS = 500;

function clip(message: string): string {
    return message.length <= MAX_ERROR_CHARS ? message : `${message.slice(0, MAX_ERROR_CHARS)}...`;
}

function tabMessage(error: RpcError): string {
    return `${clip(error.message)} Call list_tabs to see the open tabs.`;
}

export function toToolMessage(error: unknown): string {
    if (error instanceof SessionResetError) return error.message;
    if (error instanceof DaemonNotReadyError) return error.message;
    if (error instanceof ToolError) return error.message;

    if (error instanceof RpcError) {
        switch (error.code) {
            case ErrorCode.browserNotReady:
                return error.message;
            case ErrorCode.sessionRequired:
            case ErrorCode.sessionClosed:
            case ErrorCode.busy:
            case ErrorCode.internal:
            case ErrorCode.badRequest:
            case ErrorCode.unknownMethod:
                return `${error.message} Try the call again.`;
            case ErrorCode.notFound:
                return tabMessage(error);
            case ErrorCode.notOwned:
            case ErrorCode.notCreated:
            case ErrorCode.alreadyClaimed:
                return error.message;
            case ErrorCode.forbiddenMethod:
            case ErrorCode.unsupportedUrl:
                return clip(error.message);
            case ErrorCode.cdpError:
                return `${clip(error.message)} The page may have changed. Re-run the snapshot or query.`;
            case ErrorCode.cdpTimeout:
                return `${clip(error.message)} The page did not answer in time. Try again with a larger timeout or check that the tab is responsive.`;
            case ErrorCode.browserClosed:
                return `${error.message} Open a new tab with new_tab.`;
            case ErrorCode.resultTooLarge:
                return `${error.message} Narrow the request or ask for less data.`;
            default:
                logDaemon(`unmapped daemon error: ${describeError(error)}`);

                return "The daemon answered with an unexpected error. Try the call again.";
        }
    }

    if (error instanceof IpcClosedError) {
        return "The daemon connection was lost. Try the call again.";
    }

    if (error instanceof IpcTimeoutError) return `${error.message} Try the call again.`;
    if (error instanceof IpcCancelledError) return error.message;
    if (error instanceof DaemonConfigMismatchError) return error.message;

    if (error instanceof DaemonError) {
        return `${error.message} Try the call again.`;
    }

    logDaemon(`unexpected tool failure: ${describeError(error)}`);

    return "The tool failed with an unexpected error. Try the call again.";
}
