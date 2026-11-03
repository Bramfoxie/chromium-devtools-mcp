import { chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { DaemonError, errorCode } from "./errors.js";

export interface DirStat {
    uid           : number;
    mode          : number;
    isDirectory   : boolean;
    isSymbolicLink: boolean;
}

export interface DirIO {
    mkdir: (dir: string) => Promise<void>;
    lstat: (dir: string) => Promise<DirStat>;
    chmod: (dir: string, mode: number) => Promise<void>;
}

export const realDirIO: DirIO = {
    mkdir: async (dir) => {
        await mkdir(path.dirname(dir), { recursive: true });

        try {
            await mkdir(dir, { mode: 0o700 });
        } catch (error) {
            if (errorCode(error) !== "EEXIST") throw error;
        }
    },
    lstat: async (dir) => {
        const stat = await lstat(dir);

        return {
            uid           : stat.uid,
            mode          : stat.mode,
            isDirectory   : stat.isDirectory(),
            isSymbolicLink: stat.isSymbolicLink(),
        };
    },
    chmod: (dir, mode) => chmod(dir, mode),
};

export async function ensurePrivateDir(
    dir     : string,
    platform: NodeJS.Platform,
    uid     : number | undefined,
    io      : DirIO = realDirIO,
): Promise<void> {
    await io.mkdir(dir);
    if (platform === "win32") return;

    const stat = await io.lstat(dir);

    if (stat.isSymbolicLink || !stat.isDirectory) {
        throw new DaemonError(`${dir} must be a real directory. Remove it and start the daemon again.`);
    }

    if (uid !== undefined && stat.uid !== uid) {
        throw new DaemonError(
            `${dir} is owned by another user. Ask its owner to remove it, then start the daemon again.`,
        );
    }

    if ((stat.mode & 0o077) !== 0) await io.chmod(dir, 0o700);
}
