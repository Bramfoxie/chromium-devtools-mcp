import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { defineTool } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { ToolError } from "./errors.js";
import { throwIfCancelled } from "./registry.js";
import { pageOrigin } from "./storage-read.js";

export const WRITE_MAX_ENTRIES = 100;

export const WRITE_MAX_KEY_CHARS = 200;

export const WRITE_MAX_VALUE_CHARS = 100_000;

export const WRITE_MAX_KEYS = 1000;

export const WRITE_MAX_COOKIES = 100;

export const WRITE_MAX_COOKIE_NAME_CHARS = 4096;

const setCookieSchema = z.strictObject({
    name    : z.string().min(1).max(WRITE_MAX_COOKIE_NAME_CHARS).describe("Cookie name."),
    value   : z.string().max(WRITE_MAX_VALUE_CHARS).describe("Cookie value."),
    domain  : z.string().min(1).max(253).optional().describe("Cookie domain. Defaults to the page host."),
    path    : z.string().max(1024).optional().describe("Cookie path. Defaults to /."),
    expires : z.number().int().optional().describe("Expiry as seconds since the epoch."),
    secure  : z.boolean().optional().describe("Whether the cookie needs HTTPS."),
    httpOnly: z.boolean().optional().describe("Whether the cookie is hidden from page scripts."),
    sameSite: z.enum(["Strict", "Lax", "None"]).optional().describe("SameSite attribute."),
});

const removeCookieSchema = z.strictObject({
    name  : z.string().min(1).max(WRITE_MAX_COOKIE_NAME_CHARS).describe("Cookie name."),
    domain: z.string().min(1).max(253).optional().describe("Cookie domain. Defaults to the page host."),
    path  : z.string().max(1024).optional().describe("Cookie path."),
});

function isIpHost(host: string): boolean {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;

    return host.includes(":");
}

export function cookieDomainAllowed(cookieDomain: string | undefined, pageHost: string): boolean {
    const host = pageHost.toLowerCase();
    const domain = (cookieDomain ?? host).toLowerCase().replace(/^\./, "");

    if (domain === "") return false;
    if (domain === host) return true;
    if (isIpHost(host) || isIpHost(domain)) return false;
    if (!host.endsWith(`.${domain}`)) return false;
    if (!domain.includes(".")) return false;

    return true;
}

export function checkCookieDomain(
    cookieDomain: string | undefined,
    pageHost    : string,
): void {
    if (cookieDomainAllowed(cookieDomain, pageHost)) return;

    throw new ToolError(
        `The cookie domain ${JSON.stringify(cookieDomain ?? "")} is outside the page host ${JSON.stringify(pageHost)}. Cookies can only be set for the page host or its parent domains.`,
    );
}

export function pageHostOf(origin: string): string {
    return new URL(origin).hostname;
}

async function storageCount(
    access  : DaemonAccess,
    targetId: string,
    origin  : string,
    local   : boolean,
): Promise<number> {
    const parsed = z.object({ entries: z.array(z.tuple([z.string(), z.string()])) }).safeParse(
        await access.send(targetId, "DOMStorage.getDOMStorageItems", {
            storageId: { securityOrigin: origin, isLocalStorage: local },
        }),
    );

    return parsed.success ? parsed.data.entries.length : 0;
}

async function cookieCount(access: DaemonAccess, targetId: string): Promise<number> {
    const parsed = z.object({ cookies: z.array(z.object({ name: z.string() }).passthrough()) })
        .safeParse(await access.send(targetId, "Network.getCookies"));

    return parsed.success ? parsed.data.cookies.length : 0;
}

export const storageWrite = defineTool({
    name: "storage_write",
    description:
        "Write local storage, session storage or cookies of the page origin. Values are never echoed back.",
    access   : "mutate",
    dangerous: true,
    input    : z.strictObject({
        tab    : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        kind   : z.enum(["local", "session", "cookies"]).describe("What to write."),
        action : z.enum(["set", "remove", "clear"]).describe("What to do."),
        entries: z.record(z.string().min(1).max(WRITE_MAX_KEY_CHARS), z.string().max(WRITE_MAX_VALUE_CHARS)).optional().describe("Entries to set, for local and session. At most 100."),
        keys   : z.array(z.string().min(1).max(WRITE_MAX_KEY_CHARS)).max(WRITE_MAX_KEYS).optional().describe("Keys to remove, for local and session."),
        cookies: z.array(setCookieSchema).max(WRITE_MAX_COOKIES).optional().describe("Cookies to set."),
        remove : z.array(removeCookieSchema).max(WRITE_MAX_COOKIES).optional().describe("Cookies to remove."),
        confirm: z.boolean().optional().describe("Required true for clear."),
    }),
    output: z.strictObject({
        tab      : z.string().describe("Tab id."),
        kind     : z.enum(["local", "session", "cookies"]).describe("What was written."),
        action   : z.enum(["set", "remove", "clear"]).describe("What ran."),
        origin   : z.string().describe("Security origin of the page."),
        changed  : z.number().describe("Entries changed: set, removed or cleared."),
        remaining: z.number().describe("Entries left afterwards."),
        effect   : z.string().describe("Short summary of what happened. Never carries values."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        if (args.kind === "cookies") {
            if (args.entries !== undefined || args.keys !== undefined) {
                throw new ToolError("entries and keys only apply to local and session storage, not to cookies.");
            }
        } else if (args.cookies !== undefined || args.remove !== undefined) {
            throw new ToolError("cookies and remove only apply to kind cookies.");
        }

        if (args.action === "clear" && args.confirm !== true) {
            throw new ToolError(
                args.kind === "cookies"
                    ? "The clear action needs confirm: true. It removes every cookie of this page."
                    : "The clear action needs confirm: true. It removes every entry of this storage.",
            );
        }

        await ensureNoDialog(context.dialogs, targetId);
        throwIfCancelled(context.signal);

        const origin = await pageOrigin(context.access, targetId);
        const host = pageHostOf(origin);

        if (args.kind === "cookies") {
            const pageUrl = await pageUrlOf(context, targetId);

            return writeCookies(
                context.access,
                targetId,
                origin,
                host,
                pageUrl,
                args,
                context.signal,
            );
        }

        return writeDomStorage(
            context.access,
            targetId,
            origin,
            args.kind === "local",
            args,
            context.signal,
        );
    },
});

interface PageUrlContext {
    access: DaemonAccess;
}

async function pageUrlOf(context: PageUrlContext, targetId: string): Promise<string> {
    const tabs = await context.access.listTabs("owned");
    const known = tabs.find((tab) => tab.targetId === targetId);

    if (known !== undefined && known.url !== "") return known.url;

    const result = await context.access.send(
        targetId,
        "Runtime.evaluate",
        { expression: "location.href", returnByValue: true },
        5000,
    ).catch(() => undefined);
    const parsed = z.object({
        result: z.object({ value: z.unknown().optional() }),
    }).safeParse(result);
    const value = parsed.success ? parsed.data.result.value : undefined;

    if (typeof value === "string" && value !== "") return value;

    throw new ToolError("The page URL is not available, so cookies cannot be scoped to it.");
}

type WriteArgs = {
    action  : "set" | "remove" | "clear";
    entries?: Record<string, string>;
    keys?   : string[];
    confirm?: boolean;
};

async function writeDomStorage(
    access  : DaemonAccess,
    targetId: string,
    origin  : string,
    local   : boolean,
    args    : WriteArgs,
    signal  : AbortSignal,
): Promise<{
    tab      : string;
    kind     : "local" | "session";
    action   : "set" | "remove" | "clear";
    origin   : string;
    changed  : number;
    remaining: number;
    effect   : string;
}> {
    const kind = local ? "local" as const : "session" as const;

    await access.send(targetId, "DOMStorage.enable", {});

    if (args.action === "set") {
        const entries = Object.entries(args.entries ?? {});

        if (entries.length === 0) {
            throw new ToolError("The set action needs entries to set.");
        }

        if (entries.length > WRITE_MAX_ENTRIES) {
            throw new ToolError(`At most ${WRITE_MAX_ENTRIES} entries can be set at once.`);
        }

        for (const [key, value] of entries) {
            throwIfCancelled(signal);
            await access.send(targetId, "DOMStorage.setDOMStorageItem", {
                storageId: { securityOrigin: origin, isLocalStorage: local },
                key,
                value,
            });
        }

        const remaining = await storageCount(access, targetId, origin, local);

        return {
            tab    : targetId,
            kind,
            action : "set",
            origin,
            changed: entries.length,
            remaining,
            effect : entries.length === 1
                ? `One ${kind} storage entry was set.`
                : `${entries.length} ${kind} storage entries were set.`,
        };
    }

    if (args.action === "remove") {
        const keys = args.keys ?? [];

        if (keys.length === 0) {
            throw new ToolError("The remove action needs keys to remove.");
        }

        for (const key of keys) {
            throwIfCancelled(signal);
            await access.send(targetId, "DOMStorage.removeDOMStorageItem", {
                storageId: { securityOrigin: origin, isLocalStorage: local },
                key,
            });
        }

        const remaining = await storageCount(access, targetId, origin, local);

        return {
            tab    : targetId,
            kind,
            action : "remove",
            origin,
            changed: keys.length,
            remaining,
            effect : keys.length === 1
                ? `One ${kind} storage entry was removed.`
                : `${keys.length} ${kind} storage entries were removed.`,
        };
    }

    const before = await storageCount(access, targetId, origin, local);

    await access.send(targetId, "DOMStorage.clear", {
        storageId: { securityOrigin: origin, isLocalStorage: local },
    });

    return {
        tab      : targetId,
        kind,
        action   : "clear",
        origin,
        changed  : before,
        remaining: 0,
        effect   : before === 1
            ? `One ${kind} storage entry was cleared.`
            : `${before} ${kind} storage entries were cleared.`,
    };
}

type CookieWriteArgs = {
    action  : "set" | "remove" | "clear";
    cookies?: Array<z.infer<typeof setCookieSchema>>;
    remove? : Array<z.infer<typeof removeCookieSchema>>;
    confirm?: boolean;
};

async function writeCookies(
    access  : DaemonAccess,
    targetId: string,
    origin  : string,
    host    : string,
    pageUrl : string,
    args    : CookieWriteArgs,
    signal  : AbortSignal,
): Promise<{
    tab      : string;
    kind     : "cookies";
    action   : "set" | "remove" | "clear";
    origin   : string;
    changed  : number;
    remaining: number;
    effect   : string;
}> {
    if (args.action === "set") {
        const cookies = args.cookies ?? [];

        if (cookies.length === 0) {
            throw new ToolError("The set action needs cookies to set.");
        }

        // Validate every cookie before the first send: no partial writes.
        for (const cookie of cookies) checkCookieDomain(cookie.domain, host);

        let applied = 0;

        for (const cookie of cookies) {
            throwIfCancelled(signal);
            const ok = z.object({ success: z.boolean() }).safeParse(
                await access.send(targetId, "Network.setCookie", {
                    name : cookie.name,
                    value: cookie.value,
                    url  : pageUrl,
                    ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
                    ...(cookie.path === undefined ? {} : { path: cookie.path }),
                    ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
                    ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
                    ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
                    ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
                }),
            );

            if (!ok.success || !ok.data.success) {
                throw new ToolError(
                    `The cookie ${JSON.stringify(cookie.name)} was refused by the browser after ${applied} of ${cookies.length} were set. Check the domain, path and secure flags.`,
                );
            }

            applied += 1;
        }

        const remaining = await cookieCount(access, targetId);

        return {
            tab    : targetId,
            kind   : "cookies",
            action : "set",
            origin,
            changed: cookies.length,
            remaining,
            effect : cookies.length === 1 ? "One cookie was set." : `${cookies.length} cookies were set.`,
        };
    }

    if (args.action === "remove") {
        const cookies = args.remove ?? [];

        if (cookies.length === 0) {
            throw new ToolError("The remove action needs cookies to remove.");
        }

        for (const cookie of cookies) checkCookieDomain(cookie.domain, host);

        for (const cookie of cookies) {
            throwIfCancelled(signal);
            await access.send(targetId, "Network.deleteCookies", {
                name: cookie.name,
                url : pageUrl,
                ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
                ...(cookie.path === undefined ? {} : { path: cookie.path }),
            });
        }

        const remaining = await cookieCount(access, targetId);

        return {
            tab    : targetId,
            kind   : "cookies",
            action : "remove",
            origin,
            changed: cookies.length,
            remaining,
            effect : cookies.length === 1
                ? "One cookie was removed."
                : `${cookies.length} cookies were removed.`,
        };
    }

    const before = await cookieCount(access, targetId);
    const parsed = z.object({
        cookies: z.array(z.object({
            name  : z.string(),
            domain: z.string(),
            path  : z.string(),
        }).passthrough()),
    }).safeParse(await access.send(targetId, "Network.getCookies"));
    const scoped = (parsed.success ? parsed.data.cookies : []).filter((cookie) =>
        cookieDomainAllowed(cookie.domain, host),
    );

    for (const cookie of scoped) {
        throwIfCancelled(signal);
        await access.send(targetId, "Network.deleteCookies", {
            name  : cookie.name,
            url   : pageUrl,
            domain: cookie.domain,
            path  : cookie.path,
        });
    }

    const remaining = await cookieCount(access, targetId);

    return {
        tab    : targetId,
        kind   : "cookies",
        action : "clear",
        origin,
        changed: before - remaining,
        remaining,
        effect : before - remaining === 1
            ? "One cookie was cleared."
            : `${before - remaining} cookies were cleared.`,
    };
}
