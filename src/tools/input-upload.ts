import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { ensureActionable } from "./actionability.js";
import { defineTool } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import {
    elementAccess,
    elementTargetSchema,
    withElement,
    type ResolvedElement,
} from "./element-target.js";
import { ToolError } from "./errors.js";
import { changedUrl, navigationOf, summarizeTarget, targetSummarySchema } from "./input-outcome.js";
import { throwIfCancelled } from "./registry.js";
import type { UploadEnvironment } from "./upload-environment.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const UPLOAD_MAX_FILES = 20;

export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

const UPLOAD_COUNT_EXPRESSION = `function (element) {
  if (!(element instanceof HTMLInputElement) || element.type !== "file" || !element.isConnected) return { files: -1 };
  return { files: element.files === null ? 0 : element.files.length };
}`;

const uploadChangeSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.object({ files: z.number() }).optional(),
    }),
});

interface ValidatedUpload {
    path: string;
    name: string;
    size: number;
}

async function realDirectories(
    environment: UploadEnvironment,
    dirs       : readonly string[],
): Promise<string[]> {
    const { fs, path } = environment;

    return Promise.all(dirs.map(async (dir) => {
        const resolved = path.resolve(dir);

        try {
            return await fs.realpath(resolved);
        } catch {
            return resolved;
        }
    }));
}

function isInside(environment: UploadEnvironment, dir: string, file: string): boolean {
    const { path } = environment;
    const relative = path.relative(dir, file);

    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

export async function validateUploadFiles(
    environment: UploadEnvironment,
    files      : string[],
    uploadDirs : readonly string[] = [],
): Promise<ValidatedUpload[]> {
    const { fs, path } = environment;
    const allowedDirs = uploadDirs.length === 0
        ? []
        : await realDirectories(environment, uploadDirs);
    const validated: ValidatedUpload[] = [];
    const seen = new Set<string>();

    for (const file of files) {
        if (!path.isAbsolute(file)) {
            throw new ToolError(
                `The path ${JSON.stringify(file)} is not absolute. Pass absolute file paths only.`,
            );
        }

        const resolved = path.resolve(file);
        let info: { isFile(): boolean; size: number };

        try {
            info = await fs.stat(resolved);
        } catch {
            throw new ToolError(
                `The file ${JSON.stringify(file)} does not exist or cannot be read. Check the path and try again.`,
            );
        }

        if (!info.isFile()) {
            throw new ToolError(
                `The path ${JSON.stringify(file)} is not a regular file. Only files can be uploaded, not directories or devices.`,
            );
        }

        if (info.size > UPLOAD_MAX_BYTES) {
            throw new ToolError(
                `The file ${JSON.stringify(file)} is ${info.size} bytes, over the ${UPLOAD_MAX_BYTES} byte limit. Pick a smaller file.`,
            );
        }

        try {
            await fs.access(resolved);
        } catch {
            throw new ToolError(
                `The file ${JSON.stringify(file)} is not readable. Check its permissions and try again.`,
            );
        }

        const real = await fs.realpath(resolved);

        if (seen.has(real)) {
            throw new ToolError(
                `The file ${JSON.stringify(file)} is listed more than once. Pass each file once.`,
            );
        }

        const inside = allowedDirs.some((dir) => isInside(environment, dir, real));

        if (allowedDirs.length > 0 && !inside) {
            throw new ToolError(
                `The file ${JSON.stringify(file)} is outside safety.uploadDirs. Move it into one of the allowed directories, or ask the owner to add its directory to safety.uploadDirs.`,
            );
        }

        seen.add(real);
        validated.push({ path: real, name: path.basename(real), size: info.size });
    }

    return validated;
}

async function attachedCount(
    access : DaemonAccess,
    tab    : string,
    element: ResolvedElement,
): Promise<number> {
    const parsed = uploadChangeSchema.safeParse(
        await access.send({
            targetId: tab,
            method  : "Runtime.callFunctionOn",
            params  : {
                functionDeclaration: UPLOAD_COUNT_EXPRESSION,
                objectId           : element.objectId,
                arguments          : [{ objectId: element.objectId }],
                returnByValue      : true,
            },
        }),
    );

    if (!parsed.success || parsed.data.result.value === undefined) {
        throw new ToolError(
            "The browser sent an unexpected response to Runtime.callFunctionOn. Try the call again.",
        );
    }

    return parsed.data.result.value.files;
}

export const inputUpload = defineTool({
    name: "input_upload",
    description:
        "Attach local files to a file input. The most sensitive input tool: it sends local files to a web page.",
    access   : "mutate",
    dangerous: true,
    summarize: (args) => `It sends these local files to the page: ${args.files.slice(0, 5).join(", ")}${args.files.length > 5 ? ", ..." : ""}`,
    input    : z.strictObject({
        tab   : tabSchema,
        target: elementTargetSchema.describe("Element uid from a snapshot or query, or a CSS selector. Must resolve to an input of type file."),
        files : z.array(z.string().min(1).max(4096)).min(1).max(UPLOAD_MAX_FILES).describe("Absolute local paths to attach, at most 20. Each must be a readable file under 100 MiB."),
    }),
    output: z.strictObject({
        ok             : z.boolean().describe("Whether the browser accepted the file selection command."),
        inputFilesMatch: z.boolean().describe("Whether the file input still contains the requested number of files."),
        target         : targetSummarySchema.describe("The file input."),
        effect         : z.string().describe("Short summary of what happened."),
        files          : z.array(z.strictObject({
            name: z.string().describe("File name without directories."),
            size: z.number().describe("File size in bytes."),
        })).describe("Requested files, names and sizes only, never contents."),
        urlAfter: z.string().optional().describe("URL after the upload, present only when the page navigated."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        throwIfCancelled(context.signal);

        await ensureNoDialog(context.dialogs, targetId);

        const validated = await validateUploadFiles(
            context.upload,
            args.files,
            context.config.safety.uploadDirs,
        );

        await context.focus.ensure(context.access, targetId);

        return withElement(context, targetId, args.target, async (element) => {
            const owner = elementAccess(context.access, element);
            const checked = await ensureActionable(owner, targetId, element, {
                checkDisabled: true,
                checkVisible : false,
            });

            if (!checked.state.fileInput) {
                throw new ToolError(
                    `The element <${checked.state.tag}> is not a file input. Target an input of type file.`,
                );
            }

            if (validated.length > 1 && !checked.state.multiple) {
                throw new ToolError(
                    "The file input does not accept multiple files. Pass one file or target an input with the multiple attribute.",
                );
            }

            let prepared: Awaited<ReturnType<DaemonAccess["prepareUploads"]>> | undefined;
            let dispatched = false;
            let cancelOnAbort: (() => void) | undefined;

            try {
                throwIfCancelled(context.signal);

                if (context.config.safety.uploadDirs.length > 0) {
                    prepared = await context.access.prepareUploads({
                        files: validated.map((file) => file.path), signal: context.signal,
                    });

                    if (prepared.files.length !== validated.length) {
                        throw new ToolError("The daemon returned an unexpected upload preparation result. Retry the upload.");
                    }

                    const ticket = prepared.ticket;

                    cancelOnAbort = () => {
                        void context.access.cancelUploads(ticket).catch(() => undefined);
                    };

                    context.signal.addEventListener("abort", cancelOnAbort, { once: true });
                    if (context.signal.aborted) cancelOnAbort();
                }

                throwIfCancelled(context.signal);
                const acted = await navigationOf(context.access, targetId, async () => {
                    throwIfCancelled(context.signal);
                    dispatched = true;
                    await owner.send({
                        targetId,
                        method: "DOM.setFileInputFiles",
                        params: {
                            backendNodeId: element.backendNodeId,
                            files        : prepared?.files.map((file) => file.path) ??
                                validated.map((file) => file.path),
                        },
                        signal: context.signal,
                    });
                });
                const changed = changedUrl(acted.urlBefore, acted.urlAfter);
                const navigatedAway = changed.urlAfter !== undefined;
                const count = navigatedAway
                    ? undefined
                    : await attachedCount(owner, targetId, element).catch(() => undefined);
                const verified = count === validated.length;

                return {
                    ok             : true,
                    inputFilesMatch: verified,
                    target         : summarizeTarget(args.target.uid, checked.state),
                    effect         : verified
                        ? `${validated.length} file(s) are selected in the input.`
                        : "The browser accepted the file selection, but the files could not be verified in the input. Check the page to verify the attachment before retrying.",
                    files: validated.map((file, index) => ({
                        name: file.name, size: prepared?.files[index]?.size ?? file.size,
                    })),
                    ...changedUrl(acted.urlBefore, acted.urlAfter),
                };
            } finally {
                if (cancelOnAbort !== undefined) {
                    context.signal.removeEventListener("abort", cancelOnAbort);
                }

                if (prepared !== undefined && !dispatched) {
                    await context.access.cancelUploads(prepared.ticket).catch(() => undefined);
                }
            }
        });
    },
});
