import {
    CdpClosedError,
    CdpProtocolError,
    CdpSessionDetachedError,
    CdpTimeoutError,
} from "../cdp/errors.js";
import { RpcError } from "./errors.js";
import { ErrorCode } from "./protocol.js";

export function closedError(): RpcError {
    return new RpcError(ErrorCode.sessionClosed, "The session is closed.");
}

export function tabGone(): RpcError {
    return new RpcError(ErrorCode.notFound, "The tab was closed.");
}

export function translate(error: unknown): unknown {
    if (error instanceof CdpProtocolError || error instanceof CdpSessionDetachedError) {
        return new RpcError(ErrorCode.cdpError, error.message);
    }

    if (error instanceof CdpTimeoutError) return new RpcError(ErrorCode.cdpTimeout, error.message);

    if (error instanceof CdpClosedError) {
        return new RpcError(ErrorCode.browserClosed, error.message);
    }

    return error;
}
