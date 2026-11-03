import type { Config } from "../config/index.js";
import { describeUrlHost, isHostAllowed, isRestricted, isUrlAllowed } from "../safety/index.js";
import { RpcError } from "./errors.js";
import { ErrorCode } from "./protocol.js";

export type SessionSafety = Config["safety"];

export const NO_SAFETY: SessionSafety = {
    readOnly        : false,
    allowedDomains  : [],
    confirmDangerous: false,
};

type Guard = "cookie-read" | "cookie-write" | "file-attach";

const GUARDS = new Map<string, Guard>([
    ["Network.getCookies", "cookie-read"],
    ["Network.setCookie", "cookie-write"],
    ["Network.deleteCookies", "cookie-write"],
    ["DOM.setFileInputFiles", "file-attach"],
]);

function refuse(message: string): never {
    throw new RpcError(ErrorCode.forbiddenMethod, message);
}

function outside(subject: string, url: string): never {
    return refuse(
        `${subject} ${describeUrlHost(url)}, which is outside safety.allowedDomains. Use an allowed domain, or ask the owner to add it to safety.allowedDomains.`,
    );
}

export function needsTabUrl(method: string, safety: SessionSafety): boolean {
    const guard = GUARDS.get(method);

    const writes = guard === "cookie-write" || guard === "file-attach";

    return writes && isRestricted(safety.allowedDomains);
}

export function checkOpenUrl(what: string, url: string, safety: SessionSafety): void {
    if (safety.readOnly) refuse(`${what} is refused because safety.readOnly is on.`);

    if (!isUrlAllowed(url, safety.allowedDomains)) outside(`${what} would open`, url);
}

export function checkPermissionOrigin(origin: string, safety: SessionSafety): void {
    if (safety.readOnly) refuse("permission.set is refused because safety.readOnly is on.");

    if (!isUrlAllowed(origin, safety.allowedDomains)) outside("permission.set would act for", origin);
}

type Params = Record<string, unknown>;

function cookieTargets(params: Params | undefined): Params[] {
    return params === undefined ? [] : [params];
}

function checkCookieTargets(
    method : string,
    params : Record<string, unknown> | undefined,
    domains: readonly string[],
): void {
    for (const cookie of cookieTargets(params)) {
        if (typeof cookie.url === "string" && !isUrlAllowed(cookie.url, domains)) {
            outside(`${method} would write cookies for`, cookie.url);
        }

        if (typeof cookie.domain === "string") {
            const host = cookie.domain.replace(/^\./, "");

            if (!isHostAllowed(host, domains)) {
                outside(`${method} would write cookies for`, `https://${host}/`);
            }
        }
    }
}

export interface GuardedCall {
    method   : string;
    params   : Record<string, unknown> | undefined;
    safety   : SessionSafety;
    confirmed: boolean;
    tabUrl?  : string | undefined;
    frameUrl?: string | undefined;
}

export function checkGuardedCall(call: GuardedCall): void {
    const guard = GUARDS.get(call.method);

    if (guard === undefined) return;

    const { method, safety } = call;

    if (guard !== "cookie-read" && safety.readOnly) {
        refuse(`${method} changes cookies or attaches files and is refused because safety.readOnly is on.`);
    }

    if (safety.confirmDangerous && !call.confirmed) {
        refuse(
            `${method} needs the user's confirmation because safety.confirmDangerous is on, and this request carries none. Use the tool that asks for it.`,
        );
    }

    if (guard === "cookie-read" || !isRestricted(safety.allowedDomains)) return;

    for (const url of [call.tabUrl, call.frameUrl]) {
        if (url === undefined || url === "about:srcdoc") continue;

        if (!isUrlAllowed(url, safety.allowedDomains)) outside(`${method} would act on`, url);
    }

    if (call.tabUrl === undefined) {
        refuse(`${method} could not be checked against safety.allowedDomains because the tab URL is unknown. Try again.`);
    }

    if (guard === "cookie-write") checkCookieTargets(method, call.params, safety.allowedDomains);
}
