import type { Config } from "../config/index.js";
import {
    type Block,
    describeBlock,
    describeUrlHost,
    domainBlock,
    hostBlock,
    isPolicyActive,
    navigationBlock,
} from "../safety/index.js";
import { RpcError } from "./errors.js";
import { ErrorCode } from "./protocol.js";

export type SessionSafety = Config["safety"];

export const NO_SAFETY: SessionSafety = {
    readOnly            : false,
    allowedDomains      : [],
    deniedDomains       : [],
    allowPrivateNetworks: true,
    confirmDangerous    : false,
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

function outside(subject: string, url: string, block: Block = "outside-allowed"): never {
    const described = describeBlock(block);

    return refuse(`${subject} ${describeUrlHost(url)}, ${described.reason}. ${described.hint}`);
}

export function needsTabUrl(method: string, safety: SessionSafety): boolean {
    const guard = GUARDS.get(method);

    const writes = guard === "cookie-write" || guard === "file-attach";

    return writes && isPolicyActive(safety);
}

export function checkOpenUrl(what: string, url: string, safety: SessionSafety): void {
    if (safety.readOnly) refuse(`${what} is refused because safety.readOnly is on.`);

    const block = navigationBlock(url, safety);

    if (block !== undefined) outside(`${what} would open`, url, block);
}

export function checkPermissionOrigin(origin: string, safety: SessionSafety): void {
    if (safety.readOnly) refuse("permission.set is refused because safety.readOnly is on.");

    const block = domainBlock(origin, safety);

    if (block !== undefined) outside("permission.set would act for", origin, block);
}

type Params = Record<string, unknown>;

function cookieTargets(params: Params | undefined): Params[] {
    return params === undefined ? [] : [params];
}

function checkCookieTargets(
    method : string,
    params : Record<string, unknown> | undefined,
    domains: SessionSafety,
): void {
    for (const cookie of cookieTargets(params)) {
        const urlBlock = typeof cookie.url === "string" ? domainBlock(cookie.url, domains) : undefined;

        if (typeof cookie.url === "string" && urlBlock !== undefined) {
            outside(`${method} would write cookies for`, cookie.url, urlBlock);
        }

        if (typeof cookie.domain === "string") {
            const host = cookie.domain.replace(/^\./, "");

            const hostReason = hostBlock(host, domains);

            if (hostReason !== undefined) {
                outside(`${method} would write cookies for`, `https://${host}/`, hostReason);
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

    if (guard === "cookie-read" || !isPolicyActive(safety)) return;

    for (const url of [call.tabUrl, call.frameUrl]) {
        if (url === undefined || url === "about:srcdoc") continue;

        const block = domainBlock(url, safety);

        if (block !== undefined) outside(`${method} would act on`, url, block);
    }

    if (call.tabUrl === undefined) {
        refuse(`${method} could not be checked against the domain rules in safety because the tab URL is unknown. Try again.`);
    }

    if (guard === "cookie-write") checkCookieTargets(method, call.params, safety);
}
