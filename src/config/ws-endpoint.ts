export const BROWSER_PATH_PREFIX = "/devtools/browser/";

export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const WS_ENDPOINT_FORM =
    "ws://127.0.0.1:<port>/devtools/browser/<id> (host 127.0.0.1, localhost or [::1])";

export function isValidWsEndpoint(value: string): boolean {
    let url: URL;

    try {
        url = new URL(value);
    } catch {
        return false;
    }

    return (
        url.protocol === "ws:" &&
        LOOPBACK_HOSTS.has(url.hostname) &&
        url.port !== "" &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "" &&
        url.pathname.startsWith(BROWSER_PATH_PREFIX) &&
        url.pathname.length > BROWSER_PATH_PREFIX.length
    );
}
