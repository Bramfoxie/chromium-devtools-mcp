import { z } from "zod";
import { defineTool } from "./define-tool.js";
import { ToolError } from "./errors.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const ACTIONS = ["allow", "deny", "list", "wait"] as const;

const WAIT_DEFAULT_MS = 30_000;

const WAIT_MAX_MS = 120_000;

const itemSchema = z.strictObject({
    id           : z.string().describe("Download id, to pass to wait."),
    url          : z.string().describe("Address of the file with sensitive query values replaced by [redacted]."),
    filename     : z.string().describe("The file name the page suggested, cut to its last segment."),
    state        : z.enum(["inProgress", "completed", "canceled"]).describe("Where the download is."),
    receivedBytes: z.number().describe("Bytes received so far, the size of the file when it is complete."),
    totalBytes   : z.number().optional().describe("Size announced by the server, when known."),
    path         : z.string().optional().describe("Absolute path of the saved file, once it is complete."),
});

export const downloads = defineTool({
    name: "downloads",
    description:
        "Let a tab save files it downloads into a private directory, then list them or wait for one to finish.",
    access: (args) => {
        const action = (args as { action?: unknown } | undefined)?.action;

        return action === "allow" || action === "deny" ? "mutate" : "read";
    },
    input: z.strictObject({
        tab      : tabSchema,
        action   : z.enum(ACTIONS).describe("allow starts saving downloads of the tab, deny stops it, list shows them, wait returns the next finished download."),
        id       : z.string().min(1).max(128).optional().describe("With wait: wait for this download instead of the next one that finishes."),
        timeoutMs: z.number().int().min(0).max(WAIT_MAX_MS).optional().describe(`With wait: how long to wait, up to ${WAIT_MAX_MS} ms. Defaults to ${WAIT_DEFAULT_MS}.`),
    }).superRefine((value, ctx) => {
        if (value.action !== "wait" && (value.id !== undefined || value.timeoutMs !== undefined)) {
            ctx.addIssue({ code: "custom", message: "id and timeoutMs apply to wait only." });
        }
    }),
    output: z.strictObject({
        tab      : z.string().describe("Tab id."),
        enabled  : z.boolean().describe("Whether the tab saves its downloads now."),
        directory: z.string().optional().describe("The private directory that holds the files, while downloads are allowed."),
        downloads: z.array(itemSchema).optional().describe("Downloads of the tab, for list."),
        download : itemSchema.optional().describe("The finished download, for wait."),
        met      : z.boolean().optional().describe("For wait: whether a download finished in time."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);
        const { downloadState: state } = context;

        if (args.action === "allow") {
            const change = state.beginChange(targetId);

            if (change === undefined) {
                throw new ToolError("A download setting change is already in progress for this tab.");
            }

            const ensureCurrent = () => {
                if (!change.current()) throw new ToolError("The tab closed while changing downloads.");
            };

            try {
                const directory = await context.artifacts.directory("downloads");

                ensureCurrent();
                await state.subscribe(targetId);
                ensureCurrent();
                await context.access.send({
                    targetId,
                    method: "Page.enable",
                    params: {},
                });
                ensureCurrent();
                const previous = state.directoryOf(targetId);

                change.transition();
                state.allow(targetId, directory.path);

                try {
                    await context.access.send({
                        targetId,
                        method: "Page.setDownloadBehavior",
                        params: { behavior: "allow", downloadPath: directory.path },
                    });
                    ensureCurrent();
                } catch (error) {
                    if (change.current() && state.directoryOf(targetId) === directory.path) {
                        if (previous === undefined) state.deny(targetId);
                        else state.allow(targetId, previous);
                    }

                    throw error;
                }

                return { tab: targetId, enabled: true, directory: directory.path };
            } finally {
                change.end();
            }
        }

        if (args.action === "deny") {
            const change = state.beginChange(targetId);

            if (change === undefined) {
                throw new ToolError("A download setting change is already in progress for this tab.");
            }

            try {
                change.transition();
                await context.access.send({
                    targetId,
                    method: "Page.setDownloadBehavior",
                    params: { behavior: "deny" },
                });
                if (!change.current()) throw new ToolError("The tab closed while changing downloads.");

                state.deny(targetId);
            } finally {
                change.end();
            }

            return { tab: targetId, enabled: false };
        }

        const directory = state.directoryOf(targetId);
        const enabled = directory !== undefined;
        const base = { tab: targetId, enabled, ...(directory === undefined ? {} : { directory }) };

        if (args.action === "list") return { ...base, downloads: state.list(targetId) };

        if (!enabled) {
            throw new ToolError(
                "Downloads are not allowed in this tab. Call downloads with action allow first, then start the download.",
            );
        }

        const found = await state.next(
            targetId,
            args.timeoutMs ?? WAIT_DEFAULT_MS,
            (ms) => context.clock.sleep(ms),
            args.id,
        );

        return found === undefined
            ? { ...base, met: false }
            : { ...base, met: true, download: found };
    },
});
