import { stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { ensureActionable } from "./actionability.js";
import { defineTool } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { elementTargetSchema, resolveElement, type ResolvedElement } from "./element-target.js";
import { ToolError } from "./errors.js";
import { changedUrl, navigationOf, summarizeTarget, targetSummarySchema } from "./input-click.js";
import { throwIfCancelled } from "./registry.js";

export const UPLOAD_MAX_FILES = 20;

export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

export const UPLOAD_COUNT_EXPRESSION = `function (element) {
  if (!(element instanceof HTMLInputElement) || element.type !== "file") return { files: -1 };
  return { files: element.files === null ? 0 : element.files.length };
}`;

const uploadChangeSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.object({ files: z.number() }).optional(),
    }),
});

export interface UploadFileSystem {
    stat(path: string): Promise<{ isFile(): boolean; size: number }>;
    access(path: string): Promise<void>;
    realpath(path: string): Promise<string>;
}

export interface ValidatedUpload {
    path: string;
    name: string;
    size: number;
}

export function nodeUploadFs(): UploadFileSystem {
    return {
        stat  : async (path) => stat(path),
        access: async (path) => {
            const { access } = await import("node:fs/promises");
            const { constants } = await import("node:fs");

            await access(path, constants.R_OK);
        },
        realpath: async (path) => {
            const { realpath } = await import("node:fs/promises");

            return realpath(path);
        },
    };
}

export async function validateUploadFiles(
    fs   : UploadFileSystem,
    files: string[],
): Promise<ValidatedUpload[]> {
    const validated: ValidatedUpload[] = [];

    for (const file of files) {
        if (!isAbsolute(file)) {
            throw new ToolError(
                `The path ${JSON.stringify(file)} is not absolute. Pass absolute file paths only.`,
            );
        }

        const resolved = resolve(file);
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

        await fs.realpath(resolved);

        validated.push({ path: resolved, name: basename(resolved), size: info.size });
    }

    return validated;
}

async function attachedCount(
    access : DaemonAccess,
    tab    : string,
    element: ResolvedElement,
): Promise<number> {
    const parsed = uploadChangeSchema.safeParse(
        await access.send(tab, "Runtime.callFunctionOn", {
            // DOM.setFileInputFiles already fires change; read the count only.
            functionDeclaration: UPLOAD_COUNT_EXPRESSION,
            objectId           : element.objectId,
            arguments          : [{ objectId: element.objectId }],
            returnByValue      : true,
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
    input    : z.strictObject({
        tab   : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        target: elementTargetSchema.describe("Element uid from a snapshot or query, or a CSS selector. Must resolve to an input of type file."),
        files : z.array(z.string().min(1).max(4096)).min(1).max(UPLOAD_MAX_FILES).describe("Absolute local paths to attach, at most 20. Each must be a readable file under 100 MiB."),
    }),
    output: z.strictObject({
        ok    : z.boolean().describe("Whether the files were attached."),
        target: targetSummarySchema.describe("The file input."),
        effect: z.string().describe("Short summary of what happened."),
        files : z.array(z.strictObject({
            name: z.string().describe("File name without directories."),
            size: z.number().describe("File size in bytes."),
        })).describe("Attached files, names and sizes only, never contents."),
        urlAfter: z.string().optional().describe("URL after the upload, present only when the page navigated."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        throwIfCancelled(context.signal);

        await ensureNoDialog(context.dialogs, targetId);

        const validated = await validateUploadFiles(nodeUploadFs(), args.files);

        await context.focus.ensure(context.access, targetId);

        const element = await resolveElement(
            context.access,
            context.elements,
            targetId,
            args.target,
            { frames: context.frames },
        );
        // Hidden file inputs are the normal case: attaching files needs no
        // box, scroll or hit test, only a connected enabled file input.
        const checked = await ensureActionable(context.access, targetId, element, {
            checkDisabled: true,
            checkVisible : false,
        });

        if (!checked.state.fileInput) {
            throw new ToolError(
                `The element <${checked.state.tag}> is not a file input. Target an input of type file.`,
            );
        }

        throwIfCancelled(context.signal);

        const acted = await navigationOf(context.access, targetId, async () => {
            await context.access.send(targetId, "DOM.setFileInputFiles", {
                backendNodeId: element.backendNodeId,
                files        : validated.map((file) => file.path),
            });
        });
        const count = await attachedCount(context.access, targetId, element);

        if (count !== validated.length) {
            throw new ToolError(
                `The page accepted ${count} of ${validated.length} files. The input may limit the file count or types.`,
            );
        }

        return {
            ok    : true,
            target: summarizeTarget(args.target.uid, checked.state),
            effect: validated.length === 1
                ? `The file ${JSON.stringify(validated[0]?.name ?? "")} was attached.`
                : `${validated.length} files were attached.`,
            files: validated.map((file) => ({ name: file.name, size: file.size })),
            ...changedUrl(acted.urlBefore, acted.urlAfter),
        };
    },
});
