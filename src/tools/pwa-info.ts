import { z } from "zod";
import { redactUrl } from "./capture/redact.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { throwIfCancelled } from "./registry.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const READ_TIMEOUT_MS = 5000;

const TEXT_MAX_CHARS = 300;

const ICONS_SHOWN = 20;

const SHORTCUTS_SHOWN = 10;

const WORKERS_SHOWN = 10;

const ARGUMENTS_SHOWN = 5;

const SERVICE_WORKERS_EXPRESSION = `navigator.serviceWorker ? navigator.serviceWorker.getRegistrations().then(
  (registrations) => registrations.map((registration) => {
    const worker = registration.active || registration.waiting || registration.installing;
    return { scope: registration.scope, script: worker ? worker.scriptURL : "", state: worker ? worker.state : "none" };
  })) : []`;

const INSTALLABILITY_TEXT: Record<string, string> = {
    "not-in-main-frame"                      : "The page is not in the main frame.",
    "not-from-secure-origin"                 : "The page is not served from a secure origin: use https or localhost.",
    "no-manifest"                            : "The page has no web app manifest.",
    "manifest-empty"                         : "The manifest is empty or could not be parsed.",
    "start-url-not-valid"                    : "The start_url of the manifest is not valid.",
    "manifest-missing-name-or-short-name"    : "The manifest has neither name nor short_name.",
    "manifest-display-not-supported"         : "The display of the manifest must be standalone, fullscreen, minimal-ui or window-controls-overlay.",
    "manifest-missing-suitable-icon"         : "The manifest has no suitable icon: a PNG, SVG or WebP that is large enough and has the purpose any.",
    "no-acceptable-icon"                     : "No icon of the manifest is large enough in a supported format with the purpose any.",
    "cannot-download-icon"                   : "An icon of the manifest could not be downloaded.",
    "no-icon-available"                      : "The downloaded icon was empty or corrupted.",
    "no-matching-service-worker"             : "The page has no service worker that matches the scope and start URL of the manifest.",
    "no-url-for-service-worker"              : "The service worker has no URL.",
    "prefer-related-applications"            : "The manifest prefers related applications over the web app.",
    "manifest-display-override-not-supported": "The display_override of the manifest is not supported.",
    "in-incognito"                           : "The page is in a private window.",
    "not-offline-capable"                    : "The page does not work offline.",
    "url-not-supported-for-webapk"           : "The start URL is not supported for an Android install.",
};

const manifestSchema = z.object({
    url   : z.string().default(""),
    data  : z.string().optional(),
    errors: z.array(z.object({
        message : z.string(),
        critical: z.boolean().optional(),
        line    : z.number().optional(),
        column  : z.number().optional(),
    })).default([]),
    manifest: z.object({
        name           : z.string().optional(),
        description    : z.string().optional(),
        display        : z.string().optional(),
        orientation    : z.string().optional(),
        startUrl       : z.string().optional(),
        scope          : z.string().optional(),
        id             : z.string().optional(),
        themeColor     : z.string().optional(),
        backgroundColor: z.string().optional(),
        lang           : z.string().optional(),
        icons          : z.array(z.object({
            url  : z.string(),
            sizes: z.string().optional(),
            type : z.string().optional(),
        })).optional(),
        shortcuts: z
            .array(z.object({ name: z.string(), url: z.string() }))
            .optional(),
        preferRelatedApplications: z.boolean().optional(),
    }).optional(),
});

const installabilitySchema = z.object({
    installabilityErrors: z.array(z.object({
        errorId       : z.string(),
        errorArguments: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
    })),
});

const appIdSchema = z.object({
    appId        : z.string().optional(),
    recommendedId: z.string().optional(),
});

const workersSchema = z.object({
    result: z.object({
        value: z
            .array(z.object({ scope: z.string(), script: z.string(), state: z.string() }))
            .optional(),
    }),
});

function clip(text: string): string {
    return text.length <= TEXT_MAX_CHARS ? text : `${text.slice(0, TEXT_MAX_CHARS)}...`;
}

// The parsed manifest of the protocol has no short_name, so it is read from the manifest text.
function shortNameOf(data: string | undefined): string | undefined {
    if (data === undefined || data === "") return undefined;

    try {
        const raw: unknown = JSON.parse(data);
        const name = typeof raw === "object" && raw !== null
            ? (raw as Record<string, unknown>).short_name
            : undefined;

        return typeof name === "string" && name !== "" ? clip(name) : undefined;
    } catch {
        return undefined;
    }
}

function displayOf(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;

    const name = raw.replace(/^k/, "");

    return name === "Undefined" ? undefined : name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

async function readPage(context: ToolContext, targetId: string, method: string): Promise<unknown> {
    try {
        return await context.access.send({
            targetId,
            method,
            params   : {},
            timeoutMs: READ_TIMEOUT_MS,
        });
    } catch (error) {
        if (context.signal.aborted) throw error;

        return undefined;
    }
}

export const pwaInfo = defineTool({
    name       : "pwa_info",
    closedWorld: true,
    description:
        "Read what a tab says about being an installable web app: its manifest, the app id, why Chrome would not offer to install it, and its service workers. It only reads: nothing is installed or launched.",
    access: "read",
    input : z.strictObject({ tab: tabSchema }),
    output: z.strictObject({
        tab        : z.string().describe("Tab id."),
        installable: z.boolean().describe("Whether Chrome reports no problem for installing the page."),
        manifestUrl: z.string().optional().describe("Address of the manifest, absent when the page has none."),
        appId      : z.strictObject({
            id         : z.string().describe("The app id, an address."),
            recommended: z.string().optional().describe("The id the manifest should declare."),
        }).optional(),
        manifest: z.strictObject({
            name           : z.string().optional(),
            shortName      : z.string().optional(),
            description    : z.string().optional(),
            display        : z.string().optional().describe("standalone, fullscreen, minimal-ui or browser."),
            orientation    : z.string().optional(),
            startUrl       : z.string().optional().describe("With secrets in the query redacted."),
            scope          : z.string().optional(),
            themeColor     : z.string().optional(),
            backgroundColor: z.string().optional(),
            lang           : z.string().optional(),
            icons          : z.array(z.strictObject({
                url  : z.string(),
                sizes: z.string().optional(),
                type : z.string().optional(),
            })).describe("At most 20."),
            shortcuts                : z.array(z.strictObject({ name: z.string(), url: z.string() })).describe("At most 10."),
            preferRelatedApplications: z.boolean().optional(),
        }).optional().describe("The manifest as Chrome parsed it, absent when the page has none."),
        manifestErrors: z.array(z.strictObject({
            message : z.string(),
            critical: z.boolean().optional(),
            line    : z.number().optional(),
            column  : z.number().optional(),
        })).describe("Problems Chrome found while parsing the manifest."),
        installabilityErrors: z.array(z.strictObject({
            id       : z.string().describe("Chrome's id of the problem."),
            message  : z.string().describe("What it means."),
            arguments: z.array(z.string()).optional().describe("Values Chrome gave with the problem."),
        })).describe("Why Chrome would not offer to install the page. Empty when it would."),
        serviceWorkers: z.array(z.strictObject({
            scope : z.string(),
            script: z.string().describe("Address of the worker script, with secrets redacted."),
            state : z.string().describe("activated, installing, redundant and so on."),
        })).describe("Service workers registered for the origin, at most 10."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        throwIfCancelled(context.signal);
        await ensureNoDialog(context.dialogs, targetId);

        const manifest = manifestSchema.safeParse(await readPage(context, targetId, "Page.getAppManifest"));
        const installability = installabilitySchema.safeParse(
            await readPage(context, targetId, "Page.getInstallabilityErrors"),
        );
        const appId = appIdSchema.safeParse(await readPage(context, targetId, "Page.getAppId"));
        const workers = workersSchema.safeParse(
            await context.access
                .send({
                    targetId,
                    method: "Runtime.evaluate",
                    params: {
                        expression   : SERVICE_WORKERS_EXPRESSION,
                        awaitPromise : true,
                        returnByValue: true,
                    },
                    timeoutMs: READ_TIMEOUT_MS,
                })
                .catch(() => undefined),
        );
        const parsed = manifest.success ? manifest.data : undefined;
        const hasManifest = parsed !== undefined && parsed.url !== "";
        const problems = installability.success ? installability.data.installabilityErrors : [];

        return {
            tab           : targetId,
            installable   : installability.success && problems.length === 0 && hasManifest,
            ...optional("manifestUrl", hasManifest ? redactUrl(parsed.url) : undefined),
            ...optional("appId", describeAppId(appId.success ? appId.data : undefined)),
            ...optional("manifest", hasManifest ? describeManifest(parsed) : undefined),
            manifestErrors: (parsed?.errors ?? []).slice(0, ICONS_SHOWN).map((error) => ({
                message: clip(error.message),
                ...optional("critical", error.critical),
                ...optional("line", error.line),
                ...optional("column", error.column),
            })),
            installabilityErrors: problems.map((problem) => ({
                id     : problem.errorId,
                message: INSTALLABILITY_TEXT[problem.errorId] ??
                    `Chrome reports the installability problem ${problem.errorId}.`,
                ...optional(
                    "arguments",
                    problem.errorArguments.length === 0
                        ? undefined
                        : problem.errorArguments
                            .slice(0, ARGUMENTS_SHOWN)
                            .map((entry) => clip(`${entry.name}=${entry.value}`)),
                ),
            })),
            serviceWorkers: (workers.success ? (workers.data.result.value ?? []) : [])
                .slice(0, WORKERS_SHOWN)
                .map((worker) => ({
                    scope : redactUrl(worker.scope),
                    script: redactUrl(worker.script),
                    state : worker.state,
                })),
        };
    },
});

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
    return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

function describeAppId(
    found: z.infer<typeof appIdSchema> | undefined,
): { id: string; recommended?: string } | undefined {
    if (found?.appId === undefined) return undefined;

    return {
        id: redactUrl(found.appId),
        ...optional(
            "recommended",
            found.recommendedId === undefined ? undefined : redactUrl(found.recommendedId),
        ),
    };
}

function describeManifest(parsed: z.infer<typeof manifestSchema>) {
    const found = parsed.manifest;

    if (found === undefined) return undefined;

    return {
        ...optional("name", found.name === undefined ? undefined : clip(found.name)),
        ...optional("shortName", shortNameOf(parsed.data)),
        ...optional("description", found.description === undefined ? undefined : clip(found.description)),
        ...optional("display", displayOf(found.display)),
        ...optional("orientation", found.orientation?.toLowerCase()),
        ...optional("startUrl", found.startUrl === undefined ? undefined : redactUrl(found.startUrl)),
        ...optional("scope", found.scope === undefined ? undefined : redactUrl(found.scope)),
        ...optional("themeColor", found.themeColor),
        ...optional("backgroundColor", found.backgroundColor),
        ...optional("lang", found.lang),
        icons: (found.icons ?? []).slice(0, ICONS_SHOWN).map((icon) => ({
            url: redactUrl(icon.url),
            ...optional("sizes", icon.sizes),
            ...optional("type", icon.type),
        })),
        shortcuts: (found.shortcuts ?? []).slice(0, SHORTCUTS_SHOWN).map((shortcut) => ({
            name: clip(shortcut.name),
            url : redactUrl(shortcut.url),
        })),
        ...optional("preferRelatedApplications", found.preferRelatedApplications),
    };
}
