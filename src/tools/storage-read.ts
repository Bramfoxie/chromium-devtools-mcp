import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { defineTool } from "./define-tool.js";
import { assertNoDialog } from "./dialogs.js";
import { ToolError } from "./errors.js";
import { throwIfCancelled } from "./registry.js";
import { truncateText } from "./result.js";

export const STORAGE_MAX_ENTRIES = 1000;

export const STORAGE_DEFAULT_ENTRIES = 100;

export const STORAGE_MAX_VALUE_CHARS = 20_000;

export const STORAGE_DEFAULT_VALUE_CHARS = 500;

export const STORAGE_MAX_KEYS = 1000;

export const STORAGE_MAX_KEY_CHARS = 1024;

export const STORAGE_KEY_CLIP_CHARS = 200;

const itemsSchema = z.object({ entries: z.array(z.tuple([z.string(), z.string()])) });

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

export type StorageCookie = z.infer<typeof cookieSchema>;

const entrySchema = z.strictObject({
    key      : z.string().describe("Storage key, clipped to 200 characters."),
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

export async function pageOrigin(access: DaemonAccess, targetId: string): Promise<string> {
    const result = await access.send(
        targetId,
        "Runtime.evaluate",
        { expression: "location.href", returnByValue: true },
        5000,
    );
    const parsed = evaluatedSchema.safeParse(result);
    const value = parsed.success ? parsed.data.result.value : undefined;

    if (typeof value !== "string") {
        throw new ToolError(
            "The browser sent an unexpected response to Runtime.evaluate. Try the call again.",
        );
    }

    try {
        return storageOriginOf(value);
    } catch {
        throw new ToolError("The page URL is not available, so its storage cannot be read.");
    }
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
    await access.send(targetId, "DOMStorage.enable", {});

    const items = itemsSchema.safeParse(
        await access.send(targetId, "DOMStorage.getDOMStorageItems", {
            storageId: { securityOrigin: origin, isLocalStorage: local },
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
    origin    : string,
    maxEntries: number,
    maxChars  : number,
    withValues: boolean,
): Promise<Pick<z.infer<typeof storageOutput>, "count" | "returned" | "truncated" | "cookies">> {
    // No urls parameter: only cookies of the page's own URL come back.
    const parsed = cookiesSchema.safeParse(await access.send(targetId, "Network.getCookies"));

    void origin;

    if (!parsed.success) {
        throw new ToolError(
            "The browser sent an unexpected response to Network.getCookies. Try the call again.",
        );
    }

    const sliced = parsed.data.cookies.slice(0, maxEntries);

    return {
        count    : parsed.data.cookies.length,
        returned : sliced.length,
        truncated: parsed.data.cookies.length > sliced.length,
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
        "Read local storage, session storage or cookies of the page origin. Cookie values are secrets and stay hidden unless includeValues is true.",
    access: "read",
    input : z.strictObject({
        tab          : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        kind         : z.enum(["local", "session", "cookies"]).describe("What to read."),
        keys         : z.array(z.string().min(1).max(STORAGE_MAX_KEY_CHARS)).max(STORAGE_MAX_KEYS).optional().describe("Storage keys to read, for local and session. Defaults to all."),
        maxEntries   : z.number().int().min(1).max(STORAGE_MAX_ENTRIES).optional().describe("Maximum entries to return. Defaults to 100."),
        maxValueChars: z.number().int().min(1).max(STORAGE_MAX_VALUE_CHARS).optional().describe("Maximum characters per value. Defaults to 500."),
        includeValues: z.boolean().optional().describe("Include values. Defaults to true for storage, false for cookies."),
    }),
    output : storageOutput,
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        if (args.kind === "cookies" && args.keys !== undefined) {
            throw new ToolError("keys only applies to local and session storage, not to cookies.");
        }

        assertNoDialog(context.dialogs, targetId);
        throwIfCancelled(context.signal);

        const origin = await pageOrigin(context.access, targetId);
        const maxEntries = args.maxEntries ?? STORAGE_DEFAULT_ENTRIES;
        const maxChars = args.maxValueChars ?? STORAGE_DEFAULT_VALUE_CHARS;
        const withValues = args.includeValues ?? args.kind !== "cookies";

        if (args.kind === "cookies") {
            const read = await readCookies(
                context.access,
                targetId,
                origin,
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
