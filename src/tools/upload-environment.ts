import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

export interface UploadFileSystem {
    stat(path: string): Promise<{ isFile(): boolean; size: number }>;
    access(path: string): Promise<void>;
    realpath(path: string): Promise<string>;
}

type UploadPath = Pick<typeof posix, "basename" | "isAbsolute" | "relative" | "resolve" | "sep">;

export interface UploadEnvironment {
    fs  : UploadFileSystem;
    path: UploadPath;
}

function nodeUploadFs(): UploadFileSystem {
    return {
        stat    : async (path) => stat(path),
        access  : async (path) => access(path, constants.R_OK),
        realpath: async (path) => realpath(path),
    };
}

export function nodeUploadEnvironment(): UploadEnvironment {
    return { fs: nodeUploadFs(), path: process.platform === "win32" ? win32 : posix };
}
