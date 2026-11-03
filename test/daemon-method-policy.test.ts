import { describe, expect, it } from "vitest";
import { ErrorCode, normalizeUrl, RpcError } from "../src/daemon/index.js";
import { checkCall, checkEvent } from "../src/daemon/method-policy.js";

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
        "Page.setDownloadBehavior",
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
