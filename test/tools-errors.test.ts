import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DaemonConfigMismatchError,
    DaemonError,
    ErrorCode,
    IpcClosedError,
    IpcTimeoutError,
    RpcError,
} from "../src/daemon/index.js";
import { DaemonNotReadyError, SessionResetError } from "../src/mcp/index.js";
import { ToolError, toToolMessage } from "../src/tools/index.js";

afterEach(() => {
    vi.restoreAllMocks();
});

function stderrOf(run: () => unknown): string {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    run();

    return write.mock.calls.map((call) => String(call[0])).join("");
}

describe("toToolMessage", () => {
    it("passes tool errors and reset signals through", () => {
        expect(toToolMessage(new ToolError("Custom message."))).toBe("Custom message.");
        expect(toToolMessage(new SessionResetError())).toContain("Open a new tab with new_tab.");
    });

    it("passes the daemon instructions for a browser that is not ready", () => {
        const instructions = "Enable remote debugging, then retry.";

        expect(toToolMessage(new DaemonNotReadyError(instructions))).toBe(instructions);
        expect(toToolMessage(new RpcError(ErrorCode.browserNotReady, instructions))).toBe(
            instructions,
        );
    });

    it("points at list_tabs when a tab is gone", () => {
        expect(toToolMessage(new RpcError(ErrorCode.notFound, "The tab was closed."))).toContain(
            "Call list_tabs",
        );
    });

    it("suggests a snapshot rerun when a command fails", () => {
        expect(toToolMessage(new RpcError(ErrorCode.cdpError, "CDP method failed."))).toContain(
            "Re-run the snapshot or query.",
        );
    });

    it("suggests a larger timeout when the page is slow", () => {
        expect(toToolMessage(new RpcError(ErrorCode.cdpTimeout, "CDP timed out."))).toContain(
            "larger timeout",
        );
    });

    it("points at new_tab when the browser connection is gone", () => {
        expect(toToolMessage(new RpcError(ErrorCode.browserClosed, "CDP connection is closed."))).toContain(
            "Open a new tab with new_tab.",
        );
    });

    it("keeps ownership, policy and usage errors as written by the daemon", () => {
        for (const code of [
            ErrorCode.notOwned,
            ErrorCode.notCreated,
            ErrorCode.alreadyClaimed,
            ErrorCode.forbiddenMethod,
            ErrorCode.unsupportedUrl,
        ]) {
            expect(toToolMessage(new RpcError(code, `Message for ${code}.`))).toBe(
                `Message for ${code}.`,
            );
        }
    });

    it("asks to retry on transient daemon errors", () => {
        for (const code of [
            ErrorCode.sessionRequired,
            ErrorCode.sessionClosed,
            ErrorCode.busy,
            ErrorCode.internal,
            ErrorCode.badRequest,
            ErrorCode.unknownMethod,
        ]) {
            expect(toToolMessage(new RpcError(code, `Message for ${code}.`))).toBe(
                `Message for ${code}. Try the call again.`,
            );
        }
    });

    it("explains oversized results with an action", () => {
        expect(toToolMessage(new RpcError(ErrorCode.resultTooLarge, "Too large."))).toContain(
            "Narrow the request",
        );
    });

    it("maps connection failures to a retry", () => {
        expect(toToolMessage(new IpcClosedError("the client was closed"))).toContain(
            "Try the call again.",
        );
        expect(toToolMessage(new IpcTimeoutError("tab.list", 1000))).toContain("Try the call again.");
        expect(toToolMessage(new DaemonError("The daemon is gone."))).toContain("Try the call again.");
    });

    it("keeps configuration mismatch text as written", () => {
        const error = new DaemonConfigMismatchError("running a", "expected b");

        expect(toToolMessage(error)).toBe(error.message);
    });

    it("hides unknown errors behind a generic message and logs them", () => {
        const logged = stderrOf(() => {
            expect(toToolMessage(new Error("secret boom"))).toContain("unexpected error");
        });

        expect(logged).toContain("unexpected tool failure");
    });

    it("hides unmapped daemon codes behind a generic message and logs them", () => {
        const logged = stderrOf(() => {
            expect(toToolMessage(new RpcError("future_code", "From the future."))).toContain(
                "unexpected error",
            );
        });

        expect(logged).toContain("unmapped daemon error");
    });
});
