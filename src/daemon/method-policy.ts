import { RpcError } from "./errors.js";
import { ErrorCode } from "./protocol.js";

const ALLOWED_DOMAINS = new Set([
    "Accessibility",
    "CSS",
    "Console",
    "DOM",
    "DOMDebugger",
    "DOMSnapshot",
    "DOMStorage",
    "Emulation",
    "Fetch",
    "IO",
    "Input",
    "Log",
    "Network",
    "Page",
    "Performance",
    "Runtime",
]);
const ALLOWED_METHODS = new Set(["Browser.getVersion"]);
const FOCUS_METHODS = new Set(["Page.bringToFront"]);
const BLOCKED_METHODS = new Map([
    ["Page.setDownloadBehavior", "it would let a page write files to any directory"],
    ["Page.close", "it would close tabs owned by other sessions"],
    ["Page.crash", "it would crash the tab for every session using it"],
    ["Page.setInterceptFileChooserDialog", "it would change file chooser handling for the whole tab"],
    ["Network.getAllCookies", "it returns the cookies of every site in the browser"],
    ["Network.setCookies", "it would write cookies for any site without tab scoping"],
    ["Network.clearBrowserCookies", "it would delete the cookies of every site in the browser"],
    ["Network.clearBrowserCache", "it would clear the cache of every site in the browser"],
    ["Network.loadNetworkResource", "it would fetch a URL with the browser profile"],
    ["IO.read", "its handles are small integers and could belong to another session"],
    ["IO.close", "its handles are small integers and could belong to another session"],
]);
const SAFE_URL_PROTOCOLS = new Set(["http:", "https:"]);

export interface PolicyOptions {
    allowFocus: boolean;
}

function forbidden(message: string): RpcError {
    return new RpcError(ErrorCode.forbiddenMethod, message);
}

export function normalizeUrl(url: string): string {
    if (url.toLowerCase() === "about:blank") return "about:blank";

    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        throw new RpcError(ErrorCode.unsupportedUrl, "The URL is not valid.");
    }

    if (!SAFE_URL_PROTOCOLS.has(parsed.protocol)) {
        throw new RpcError(
            ErrorCode.unsupportedUrl,
            "Only http, https and about:blank URLs can be opened.",
        );
    }

    return parsed.href;
}

export function checkEvent(event: string): void {
    const dot = event.indexOf(".");
    const domain = dot === -1 ? event : event.slice(0, dot);

    if (!ALLOWED_DOMAINS.has(domain)) {
        throw forbidden(
            `${event} is not available through a tab. Use the tab operations of the daemon instead.`,
        );
    }
}

// Returns the params to send to the browser; Page.navigate gets the normalized URL.
export function checkCall(
    method : string,
    params : Record<string, unknown> | undefined,
    options: PolicyOptions,
): Record<string, unknown> | undefined {
    if (!ALLOWED_METHODS.has(method)) checkEvent(method);

    const blocked = BLOCKED_METHODS.get(method);

    if (blocked) throw forbidden(`${method} is not allowed because ${blocked}.`);

    if (FOCUS_METHODS.has(method) && !options.allowFocus) {
        throw forbidden(
            `${method} would bring the window to the front. Enable allowFocus in the config to allow it.`,
        );
    }

    if (method === "Page.navigate") {
        const url = params?.url;

        if (typeof url !== "string") {
            throw new RpcError(ErrorCode.badRequest, "Page.navigate needs a url string.");
        }

        return { ...params, url: normalizeUrl(url) };
    }

    if (method === "Network.getCookies" && params?.urls !== undefined) {
        throw forbidden(
            "Network.getCookies with urls is not allowed because it reads the cookies of other sites.",
        );
    }

    return params;
}
