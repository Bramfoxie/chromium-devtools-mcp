import { realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { RpcError } from "./errors.js";
import { ErrorCode } from "./protocol.js";
import { UploadSourceUnavailableError } from "./upload-source.js";

export type UploadPathResolver = (path: string) => Promise<string>;

export async function checkUploadPaths(
    files   : unknown,
    dirs    : readonly string[],
    platform: NodeJS.Platform,
    resolve : UploadPathResolver = realpath,
): Promise<string[]> {
    if (dirs.length === 0) return [];

    if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) {
        throw new RpcError(ErrorCode.forbiddenMethod, "File attachment needs valid paths to check safety.uploadDirs.");
    }

    if (files.length === 0) return [];

    const path = platform === "win32" ? win32 : posix;

    try {
        const results = await Promise.allSettled(
            dirs.map(async (dir) => resolve(path.resolve(dir))),
        );
        const roots = results.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : []);

        for (const file of files) {
            if (!path.isAbsolute(file)) throw new Error("relative path");

            const real = await resolve(path.resolve(file));
            const inside = roots.some((root) => {
                const relative = path.relative(root, real);

                return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
                    !path.isAbsolute(relative);
            });

            if (!inside) throw new Error("outside the allowed directories");
        }

        return roots;
    } catch (error) {
        if (error instanceof UploadSourceUnavailableError) throw error;

        throw new RpcError(ErrorCode.forbiddenMethod, "File attachment could not be checked against safety.uploadDirs. Use readable files in an allowed directory.");
    }
}
