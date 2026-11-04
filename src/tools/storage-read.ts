import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { defineTool } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { ToolError } from "./errors.js";
import { assertPageAllowed } from "./page-allowed.js";
import { throwIfCancelled } from "./registry.js";
import { truncateText } from "./result.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const STORAGE_MAX_ENTRIES = 1000;

const STORAGE_DEFAULT_ENTRIES = 100;

const STORAGE_MAX_VALUE_CHARS = 20_000;

const STORAGE_DEFAULT_VALUE_CHARS = 500;

const STORAGE_MAX_KEYS = 1000;

const STORAGE_MAX_KEY_CHARS = 1024;

const STORAGE_KEY_CLIP_CHARS = 200;

export const itemsSchema = z.object({ entries: z.array(z.tuple([z.string(), z.string()])) });

const evaluatedSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.unknown().optional(),
    }),
});

const cookieSchema = z.object({
    name    : z.string(),
    value   : z.string(),
    domain  : z.string(),
    path    : z.string(),
    expires : z.number(),
    size    : z.number(),
    httpOnly: z.boolean(),
    secure  : z.boolean(),
    session : z.boolean(),
    sameSite: z.string().optional(),
});

const cookiesSchema = z.object({ cookies: z.array(cookieSchema) });

type StorageCookie = z.infer<typeof cookieSchema>;

const entrySchema = z.strictObject({
    key      : z.string().describe(`Storage key, clipped to ${STORAGE_KEY_CLIP_CHARS} characters.`),
    value    : z.string().optional().describe("Value clipped to maxValueChars, present only with includeValues."),
    valueSize: z.number().describe("Full value length in characters."),
    truncated: z.boolean().describe("Whether the value was clipped."),
});

const cookieEntrySchema = z.strictObject({
    name     : z.string().describe("Cookie name."),
    domain   : z.string().describe("Cookie domain."),
    path     : z.string().describe("Cookie path."),
    expires  : z.number().describe("Expiry as seconds since the epoch, -1 for a session cookie."),
    secure   : z.boolean().describe("Whether the cookie needs HTTPS."),
    httpOnly : z.boolean().describe("Whether the cookie is hidden from page scripts."),
    sameSite : z.string().optional().describe("SameSite attribute, when set."),
    size     : z.number().describe("Cookie size in bytes as reported by the browser."),
    value    : z.string().optional().describe("Cookie value, only with includeValues, clipped to maxValueChars. Secrets: handle with care."),
    truncated: z.boolean().optional().describe("Whether the value was clipped, present only with includeValues."),
});

const storageOutput = z.strictObject({
    tab          : z.string().describe("Tab id."),
    kind         : z.enum(["local", "session", "cookies"]).describe("What was read."),
    origin       : z.string().describe("Security origin of the page."),
    count        : z.number().describe("Entries after the key filter, before maxEntries."),
    returned     : z.number().describe("Entries in this result."),
    truncated    : z.boolean().describe("Whether maxEntries cut the result."),
    entries      : z.array(entrySchema).optional().describe("Storage entries, for local and session."),
    cookies      : z.array(cookieEntrySchema).optional().describe("Cookies, for cookies."),
    includeValues: z.boolean().describe("Whether values are included."),
});

export function storageOriginOf(url: string): string {
    return new URL(url).origin;
}

export function storageKeysOf(keys: string[] | undefined, names: string[]): string[] {
    if (keys === undefined) return [...names];

    const wanted = new Set(keys);

    return names.filter((name) => wanted.has(name));
}

function domainMatches(host: string, domain: string): boolean {
    if (!domain.startsWith(".")) return host === domain;

    return host === domain.slice(1) || host.endsWith(domain);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
    if (requestPath === cookiePath) return true;

    if (!requestPath.startsWith(cookiePath)) return false;

    return cookiePath.endsWith("/") || requestPath.charAt(cookiePath.length) === "/";
}

export function cookieMatchesUrl(
    cookie: Pick<StorageCookie, "domain" | "path" | "secure">,
    url   : string,
): boolean {
    const target = new URL(url);
    const secureContext = target.protocol === "https:" || target.hostname === "localhost";

    if (cookie.secure && !secureContext) return false;

    return (
        domainMatches(target.hostname, cookie.domain) && pathMatches(target.pathname, cookie.path)
    );
}

const PAGE_LOCATION_TIMEOUT_MS = 5000;

export async function pageLocation(
    access  : DaemonAccess,
    targetId: string,
): Promise<{ href: string; origin: string }> {
    const result = await access.send({
        targetId,
        method   : "Runtime.evaluate",
        params   : { expression: "location.href", returnByValue: true },
        timeoutMs: PAGE_LOCATION_TIMEOUT_MS,
    });
    const parsed = evaluatedSchema.safeParse(result);
    const value = parsed.success ? parsed.data.result.value : undefined;

    if (typeof value !== "string") {
        throw new ToolError(
            "The browser sent an unexpected response to Runtime.evaluate. Try the call again.",
        );
    }

    let origin: string;

    try {
        origin = storageOriginOf(value);
    } catch {
        throw new ToolError("The page URL is not available, so its storage cannot be read.");
    }

    if (origin === "null") {
        throw new ToolError(
            "The page has an opaque origin (for example about:blank, a data: or a file: page), so it has no storage or cookies of its own. Navigate the tab to an http or https page first.",
        );
    }

    return { href: value, origin };
}

export async function pageOrigin(access: DaemonAccess, targetId: string): Promise<string> {
    return (await pageLocation(access, targetId)).origin;
}

async function readDomStorage(
    access    : DaemonAccess,
    targetId  : string,
    origin    : string,
    local     : boolean,
    keys      : string[] | undefined,
    maxEntries: number,
    maxChars  : number,
    withValues: boolean,
): Promise<Pick<z.infer<typeof storageOutput>, "count" | "returned" | "truncated" | "entries">> {
    await access.send({
        targetId,
        method: "DOMStorage.enable",
        params: {},
    });

    const items = itemsSchema.safeParse(
        await access.send({
            targetId,
            method: "DOMStorage.getDOMStorageItems",
            params: {
                storageId: { securityOrigin: origin, isLocalStorage: local },
            },
        }),
    );

    if (!items.success) {
        throw new ToolError(
            "The browser sent an unexpected response to DOMStorage.getDOMStorageItems. Try the call again.",
        );
    }

    const names = items.data.entries.map(([key]) => key);
    const kept = storageKeysOf(keys, names);
    const values = new Map(items.data.entries);
    const sliced = kept.slice(0, maxEntries);

    return {
        count    : kept.length,
        returned : sliced.length,
        truncated: kept.length > sliced.length,
        entries  : sliced.map((key) => {
            const raw = values.get(key) ?? "";
            const shaped = truncateText(raw, maxChars);

            return {
                key      : truncateText(key, STORAGE_KEY_CLIP_CHARS).text,
                ...(withValues ? { value: shaped.text } : {}),
                valueSize: shaped.totalLength,
                truncated: withValues && shaped.truncated,
            };
        }),
    };
}

async function readCookies(
    access    : DaemonAccess,
    targetId  : string,
    href      : string,
    maxEntries: number,
    maxChars  : number,
    withValues: boolean,
): Promise<Pick<z.infer<typeof storageOutput>, "count" | "returned" | "truncated" | "cookies">> {
    const parsed = cookiesSchema.safeParse(await access.send({
        targetId,
        method: "Network.getCookies",
    }));

    if (!parsed.success) {
        throw new ToolError(
            "The browser sent an unexpected response to Network.getCookies. Try the call again.",
        );
    }

    const matching = parsed.data.cookies.filter((cookie) => cookieMatchesUrl(cookie, href));
    const sliced = matching.slice(0, maxEntries);

    return {
        count    : matching.length,
        returned : sliced.length,
        truncated: matching.length > sliced.length,
        cookies  : sliced.map((cookie) => {
            const shaped = truncateText(cookie.value, maxChars);

            return {
                name    : cookie.name,
                domain  : cookie.domain,
                path    : cookie.path,
                expires : cookie.expires,
                secure  : cookie.secure,
                httpOnly: cookie.httpOnly,
                ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
                size    : cookie.size,
                ...(withValues ? { value: shaped.text, truncated: shaped.truncated } : {}),
            };
        }),
    };
}

export const storageRead = defineTool({
    name: "storage_read",
    description:
        "Read local storage, session storage or cookies of the page origin; the result lists keys and value sizes, and values are hidden unless you pass includeValues: true.",
    access   : "read",
    dangerous: (args) => args.kind === "cookies",
    summarize: (args) =>
        `It reads the cookies of the page${args.includeValues === true ? ", including their values" : ""}.`,
    input: z.strictObject({
        tab          : tabSchema,
        kind         : z.enum(["local", "session", "cookies"]).describe("What to read."),
        keys         : z.array(z.string().min(1).max(STORAGE_MAX_KEY_CHARS)).max(STORAGE_MAX_KEYS).optional().describe("Storage keys to read, for local and session. Defaults to all."),
        maxEntries   : z.number().int().min(1).max(STORAGE_MAX_ENTRIES).optional().describe("Maximum entries to return. Defaults to 100."),
        maxValueChars: z.number().int().min(1).max(STORAGE_MAX_VALUE_CHARS).optional().describe("Maximum characters per value. Defaults to 500."),
        includeValues: z.boolean().optional().describe("Include values. Defaults to false; pass true to read them. Cookie values are secrets."),
    }),
    output : storageOutput,
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        if (args.kind === "cookies" && args.keys !== undefined) {
            throw new ToolError("keys only applies to local and session storage, not to cookies.");
        }

        await ensureNoDialog(context.dialogs, targetId);
        throwIfCancelled(context.signal);

        const { href, origin } = await pageLocation(context.access, targetId);
        const maxEntries = args.maxEntries ?? STORAGE_DEFAULT_ENTRIES;
        const maxChars = args.maxValueChars ?? STORAGE_DEFAULT_VALUE_CHARS;
        const withValues = args.includeValues ?? false;

        if (args.kind === "cookies") {
            assertPageAllowed(context, href, "The cookies belong to a page that shows");

            const read = await readCookies(
                context.access,
                targetId,
                href,
                maxEntries,
                maxChars,
                withValues,
            );

            return {
                tab          : targetId,
                kind         : args.kind,
                origin,
                count        : read.count,
                returned     : read.returned,
                truncated    : read.truncated,
                cookies      : read.cookies,
                includeValues: withValues,
            };
        }

        const read = await readDomStorage(
            context.access,
            targetId,
            origin,
            args.kind === "local",
            args.keys,
            maxEntries,
            maxChars,
            withValues,
        );

        return {
            tab          : targetId,
            kind         : args.kind,
            origin,
            count        : read.count,
            returned     : read.returned,
            truncated    : read.truncated,
            entries      : read.entries,
            includeValues: withValues,
        };
    },
});
