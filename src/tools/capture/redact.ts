const REDACTED = "[redacted]";

const SENSITIVE_WORDS = new Set([
    "token",
    "tokens",
    "key",
    "keys",
    "secret",
    "secrets",
    "password",
    "passwords",
    "passwd",
    "pwd",
    "pw",
    "pass",
    "passcode",
    "passphrase",
    "auth",
    "authorization",
    "authentication",
    "session",
    "sessions",
    "sid",
    "sig",
    "signature",
    "code",
    "otp",
    "jwt",
    "credential",
    "credentials",
    "bearer",
    "cookie",
    "apikey",
    "accesskey",
    "secretkey",
    "privatekey",
    "authkey",
    "sessionkey",
    "sessid",
    "phpsessid",
]);

const SENSITIVE_SUFFIXES = ["token", "secret", "password", "passwd", "sessionid", "signature", "apikey"];

const SENSITIVE_HEADERS = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
]);

const URL_BEARING_HEADERS = new Set(["referer", "location", "origin", "content-location"]);

function nameTokens(name: string): string[] {
    return name
        .replace(/([a-z])([0-9])/g, "$1 $2")
        .replace(/([0-9])([a-z])/gi, "$1 $2")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token !== "");
}

export function sensitiveName(name: string): boolean {
    const endsSensitive = (token: string): boolean =>
        SENSITIVE_SUFFIXES.some((suffix) => token.length > suffix.length && token.endsWith(suffix));

    return nameTokens(name).some((token) => SENSITIVE_WORDS.has(token) || endsSensitive(token));
}

function decodeText(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

function looksLikeUrl(value: string): boolean {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^\/[^?#]*[?#]/.test(value);
}

function redactValue(value: string): string {
    const decoded = decodeText(value.replace(/\+/g, " "));

    if (!looksLikeUrl(decoded)) return value;

    const inner = redactUrl(decoded);

    return inner === decoded ? value : encodeURIComponent(inner);
}

function redactParams(raw: string): string {
    return raw.split("&").map((pair) => {
        const cut = pair.indexOf("=");
        const name = cut === -1 ? pair : pair.slice(0, cut);

        if (sensitiveName(decodeText(name))) return `${name}=${REDACTED}`;

        return cut === -1 ? pair : `${name}=${redactValue(pair.slice(cut + 1))}`;
    }).join("&");
}

function redactPathParams(path: string): string {
    return path.replace(/;([^=;/?#]+)=([^;/?#]*)/g, (match, name: string) =>
        sensitiveName(decodeText(name)) ? `;${name}=${REDACTED}` : match);
}

export function redactUrl(url: string): string {
    const withoutUserinfo = url.replace(
        /^((?:https?|wss?|ftp):\/\/)[^@/?#]*@/i,
        `$1${REDACTED}@`,
    );
    const hash = withoutUserinfo.indexOf("#");
    const beforeHash = hash === -1 ? withoutUserinfo : withoutUserinfo.slice(0, hash);
    const query = beforeHash.indexOf("?");
    const path = query === -1 ? beforeHash : beforeHash.slice(0, query);
    const queryPart = query === -1 ? "" : `?${redactParams(beforeHash.slice(query + 1))}`;
    const hashPart = hash === -1 ? "" : `#${redactParams(withoutUserinfo.slice(hash + 1))}`;

    return `${redactPathParams(path)}${queryPart}${hashPart}`;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
    const redacted: Record<string, string> = {};

    for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase();

        const sensitive = SENSITIVE_HEADERS.has(lower) || sensitiveName(name);

        if (sensitive) {
            redacted[name] = REDACTED;

            continue;
        }

        redacted[name] = URL_BEARING_HEADERS.has(lower) ? redactUrl(value) : value;
    }

    return redacted;
}
