export class CdpError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "CdpError";
    }
}

export class CdpProtocolError extends CdpError {
    constructor(
        readonly method: string,
        readonly code  : number | undefined,
        detail         : string,
    ) {
        super(
            `CDP method ${method} failed${code === undefined ? "" : ` with code ${code}`}: ${detail}. ` +
        "Check the method name, its parameters and that the target is still open.",
        );
        this.name = "CdpProtocolError";
    }
}

export class CdpTimeoutError extends CdpError {
    constructor(
        readonly method   : string,
        readonly timeoutMs: number,
    ) {
        super(
            `CDP request ${method} timed out after ${timeoutMs} ms. ` +
        "Check that the tab is responsive or raise the timeout.",
        );
        this.name = "CdpTimeoutError";
    }
}

export class CdpClosedError extends CdpError {
    constructor(detail: string, options?: { cause?: unknown }) {
        super(
            `CDP connection is closed: ${detail}. Reconnect to the browser and retry.`,
            options,
        );
        this.name = "CdpClosedError";
    }
}
