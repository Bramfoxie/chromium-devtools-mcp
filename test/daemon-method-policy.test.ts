import { describe, expect, it } from "vitest";
import { ErrorCode, normalizeUrl, RpcError } from "../src/daemon/index.js";
import {
    checkCall,
    checkEvent,
    type PolicyOptions,
    TRACE_CATEGORIES,
} from "../src/daemon/method-policy.js";

const off = { allowFocus: false };

function codeOf(action: () => void): string | undefined {
    try {
        action();
    } catch (error) {
        return error instanceof RpcError ? error.code : "not an RpcError";
    }

    return undefined;
}

describe("normalizeUrl", () => {
    it("accepts http, https and about:blank", () => {
        expect(normalizeUrl("https://a.example")).toBe("https://a.example/");
        expect(normalizeUrl("http://a.example/x?y")).toBe("http://a.example/x?y");
        expect(normalizeUrl("ABOUT:BLANK")).toBe("about:blank");
    });

    it.each(["file:///etc/hosts", "chrome://settings", "javascript:alert(1)", "data:text/html,x", "nope"])(
        "rejects %s",
        (url) => {
            expect(codeOf(() => normalizeUrl(url))).toBe(ErrorCode.unsupportedUrl);
        },
    );
});

describe("checkCall", () => {
    it("allows ordinary tab commands", () => {
        expect(codeOf(() => checkCall("Runtime.evaluate", { expression: "1" }, off))).toBeUndefined();
        expect(codeOf(() => checkCall("Page.reload", undefined, off))).toBeUndefined();
    });

    it("allows Browser.getVersion and nothing else of the Browser domain", () => {
        expect(codeOf(() => checkCall("Browser.getVersion", undefined, off))).toBeUndefined();
        expect(codeOf(() => checkCall("Browser.getVersionX", undefined, off))).toBe(
            ErrorCode.forbiddenMethod,
        );
        expect(codeOf(() => checkCall("Browser.setDownloadBehavior", undefined, off))).toBe(
            ErrorCode.forbiddenMethod,
        );
    });

    it.each(["Target.getTargets", "Browser.close", "Storage.getCookies", "Storage.setCookies", "Storage.clearCookies", "SystemInfo.getInfo"])(
        "refuses the domain of %s",
        (method) => {
            expect(codeOf(() => checkCall(method, undefined, off))).toBe(ErrorCode.forbiddenMethod);
        },
    );

    it.each([
        "Page.close",
        "Page.crash",
        "Page.setInterceptFileChooserDialog",
        "Network.getAllCookies",
        "Network.setCookies",
        "Network.clearBrowserCookies",
        "Network.clearBrowserCache",
        "Network.loadNetworkResource",
        "IO.read",
        "IO.close",
    ])("refuses %s", (method) => {
        expect(codeOf(() => checkCall(method, undefined, { allowFocus: true }))).toBe(
            ErrorCode.forbiddenMethod,
        );
    });

    describe("Page.setDownloadBehavior", () => {
        const posix = { allowFocus: false, downloadsRoot: "/data/artifacts", platform: "linux" } as const;
        const win = {
            allowFocus   : false,
            downloadsRoot: "C:\\Users\\u\\AppData\\Local\\app\\artifacts",
            platform     : "win32",
        } as const;
        const call = (
            params : Record<string, unknown> | undefined,
            options: PolicyOptions = posix,
        ) =>
            checkCall("Page.setDownloadBehavior", params, options);

        it("allows a download into a directory inside the artifacts directory", () => {
            expect(call({ behavior: "allow", downloadPath: "/data/artifacts/downloads-1" })).toEqual({
                behavior    : "allow",
                downloadPath: "/data/artifacts/downloads-1",
            });
            expect(
                call(
                    { behavior: "allow", downloadPath: "C:\\Users\\u\\AppData\\Local\\app\\artifacts\\d-1" },
                    win,
                ),
            ).toMatchObject({ behavior: "allow" });
        });

        it("allows turning downloads off or back to the default, without a path", () => {
            expect(call({ behavior: "deny" })).toEqual({ behavior: "deny" });
            expect(call({ behavior: "default" })).toEqual({ behavior: "default" });
            expect(codeOf(() => call({ behavior: "deny", downloadPath: "/data/artifacts/x" })))
                .toBe(ErrorCode.badRequest);
        });

        it.each([
            "/etc",
            "/data/artifacts",
            "/data/artifacts/../secret",
            "/data/artifacts-other/x",
            "/data/artifactsx",
            "relative/dir",
            "/",
        ])("refuses the path %s", (downloadPath) => {
            expect(codeOf(() => call({ behavior: "allow", downloadPath }))).toBe(
                ErrorCode.forbiddenMethod,
            );
        });

        it("refuses a Windows path on another drive or outside the root", () => {
            for (const downloadPath of ["D:\\artifacts\\x", "C:\\Users\\u\\Desktop"]) {
                expect(codeOf(() => call({ behavior: "allow", downloadPath }, win))).toBe(
                    ErrorCode.forbiddenMethod,
                );
            }
        });

        it("refuses allow when the daemon has no directory, and unknown or missing parameters", () => {
            expect(codeOf(() => call({ behavior: "allow", downloadPath: "/data/artifacts/x" }, off as never)))
                .toBe(ErrorCode.forbiddenMethod);
            expect(codeOf(() => call({ behavior: "allow" }))).toBe(ErrorCode.badRequest);
            expect(codeOf(() => call({ behavior: "allowAndName", downloadPath: "/data/artifacts/x" })))
                .toBe(ErrorCode.badRequest);
            expect(codeOf(() => call({ behavior: "deny", eventsEnabled: true }))).toBe(ErrorCode.badRequest);
            expect(codeOf(() => call(undefined))).toBe(ErrorCode.badRequest);
        });
    });

    it("refuses bringing the window to the front unless allowFocus is on", () => {
        expect(codeOf(() => checkCall("Page.bringToFront", undefined, off))).toBe(
            ErrorCode.forbiddenMethod,
        );
        expect(
            codeOf(() => checkCall("Page.bringToFront", undefined, { allowFocus: true })),
        ).toBeUndefined();
    });

    it("hands Page.navigate the normalized URL and keeps other params", () => {
        expect(checkCall("Page.navigate", { url: " HTTPS://A.example ", frameId: "f" }, off)).toEqual({
            url    : "https://a.example/",
            frameId: "f",
        });
        expect(checkCall("Runtime.evaluate", { expression: "1" }, off)).toEqual({ expression: "1" });
        expect(checkCall("Page.reload", undefined, off)).toBeUndefined();
    });

    it("scopes Network.getCookies to the tab and refuses other sites", () => {
        expect(codeOf(() => checkCall("Network.getCookies", undefined, off))).toBe(undefined);
        expect(
            codeOf(() => checkCall("Network.getCookies", { urls: ["https://a.example/"] }, off)),
        ).toBe(ErrorCode.forbiddenMethod);
    });

    it("lets Page.navigate open only http, https and about:blank", () => {
        expect(codeOf(() => checkCall("Page.navigate", { url: "https://a.example/" }, off))).toBe(
            undefined,
        );
        expect(codeOf(() => checkCall("Page.navigate", { url: "file:///etc/hosts" }, off))).toBe(
            ErrorCode.unsupportedUrl,
        );
        expect(codeOf(() => checkCall("Page.navigate", { url: "chrome://settings" }, off))).toBe(
            ErrorCode.unsupportedUrl,
        );
        expect(codeOf(() => checkCall("Page.navigate", undefined, off))).toBe(ErrorCode.badRequest);
        expect(codeOf(() => checkCall("Page.navigate", { url: 5 }, off))).toBe(ErrorCode.badRequest);
    });
});

describe("checkEvent", () => {
    it("allows events of tab domains and refuses the rest", () => {
        expect(codeOf(() => checkEvent("Network.requestWillBeSent"))).toBeUndefined();
        expect(codeOf(() => checkEvent("Target.targetCreated"))).toBe(ErrorCode.forbiddenMethod);
    });
});

describe("tracing", () => {
    const fixed = { categories: TRACE_CATEGORIES.join(","), transferMode: "ReportEvents" };

    it("starts a trace with the fixed categories and the event transfer mode", () => {
        expect(checkCall("Tracing.start", undefined, off)).toEqual(fixed);
        expect(checkCall("Tracing.start", { transferMode: "ReportEvents" }, off)).toEqual(fixed);
        expect(
            checkCall("Tracing.start", { categories: "devtools.timeline,loading" }, off),
        ).toEqual({ categories: "devtools.timeline,loading", transferMode: "ReportEvents" });
    });

    it.each([
        [{ categories: "disabled-by-default-memory-infra" }],
        [{ categories: "devtools.timeline,netlog" }],
        [{ categories: "" }],
        [{ categories: 5 }],
    ])("refuses the categories %j", (params) => {
        expect(codeOf(() => checkCall("Tracing.start", params, off))).toBe(ErrorCode.forbiddenMethod);
    });

    it.each([
        [{ transferMode: "ReturnAsStream" }],
        [{ traceConfig: { recordMode: "recordUntilFull" } }],
        [{ streamFormat: "proto" }],
        [{ bufferUsageReportingInterval: 1 }],
    ])("refuses the parameters %j", (params) => {
        expect(codeOf(() => checkCall("Tracing.start", params, off))).toBe(ErrorCode.badRequest);
    });

    it("allows ending a trace and refuses every other Tracing method", () => {
        expect(codeOf(() => checkCall("Tracing.end", undefined, off))).toBeUndefined();

        for (const method of [
            "Tracing.getCategories",
            "Tracing.requestMemoryDump",
            "Tracing.recordClockSyncMarker",
        ]) {
            expect(codeOf(() => checkCall(method, undefined, off))).toBe(ErrorCode.forbiddenMethod);
        }
    });

    it("lets a client listen for the trace data and its end only", () => {
        expect(codeOf(() => checkEvent("Tracing.dataCollected"))).toBeUndefined();
        expect(codeOf(() => checkEvent("Tracing.tracingComplete"))).toBeUndefined();
        expect(codeOf(() => checkEvent("Tracing.bufferUsage"))).toBe(ErrorCode.forbiddenMethod);
    });
});

describe("heap snapshots", () => {
    it("takes a snapshot with progress reports turned off", () => {
        expect(checkCall("HeapProfiler.takeHeapSnapshot", undefined, off)).toEqual({
            reportProgress: false,
        });
        expect(
            checkCall(
                "HeapProfiler.takeHeapSnapshot",
                {
                    reportProgress           : true,
                    treatGlobalObjectsAsRoots: true,
                    captureNumericValue      : false,
                },
                off,
            ),
        ).toEqual({
            reportProgress           : false,
            treatGlobalObjectsAsRoots: true,
            captureNumericValue      : false,
        });
    });

    it.each([
        [{ exposeInternals: true }],
        [{ captureNumericValue: "yes" }],
        [{ treatGlobalObjectsAsRoots: 1 }],
    ])("refuses the snapshot parameters %j", (params) => {
        expect(codeOf(() => checkCall("HeapProfiler.takeHeapSnapshot", params, off))).toBe(
            ErrorCode.badRequest,
        );
    });

    it("allows a garbage collection without parameters and refuses the rest of the domain", () => {
        expect(codeOf(() => checkCall("HeapProfiler.collectGarbage", undefined, off))).toBeUndefined();
        expect(codeOf(() => checkCall("HeapProfiler.collectGarbage", { x: 1 }, off))).toBe(
            ErrorCode.badRequest,
        );

        for (const method of [
            "HeapProfiler.startSampling",
            "HeapProfiler.getHeapObjectId",
            "HeapProfiler.addInspectedHeapObject",
            "HeapProfiler.startTrackingHeapObjects",
        ]) {
            expect(codeOf(() => checkCall(method, undefined, off))).toBe(ErrorCode.forbiddenMethod);
        }
    });

    it("lets a client listen for the snapshot chunks only", () => {
        expect(codeOf(() => checkEvent("HeapProfiler.addHeapSnapshotChunk"))).toBeUndefined();
        expect(codeOf(() => checkEvent("HeapProfiler.reportHeapSnapshotProgress"))).toBe(
            ErrorCode.forbiddenMethod,
        );
        expect(codeOf(() => checkEvent("HeapProfiler.lastSeenObjectId"))).toBe(
            ErrorCode.forbiddenMethod,
        );
    });
});

describe("web authentication", () => {
    it("allows the virtual authenticator methods and events of a tab", () => {
        for (const method of [
            "WebAuthn.enable",
            "WebAuthn.addVirtualAuthenticator",
            "WebAuthn.removeVirtualAuthenticator",
            "WebAuthn.addCredential",
            "WebAuthn.getCredentials",
            "WebAuthn.removeCredential",
            "WebAuthn.clearCredentials",
            "WebAuthn.setUserVerified",
            "WebAuthn.disable",
        ]) {
            expect(codeOf(() => checkCall(method, undefined, off))).toBeUndefined();
        }

        expect(codeOf(() => checkEvent("WebAuthn.credentialAdded"))).toBeUndefined();
        expect(codeOf(() => checkEvent("WebAuthn.credentialAsserted"))).toBeUndefined();
    });
});
