import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, constants, lstatSync, openSync, truncateSync } from "node:fs";
import { pathFor } from "../config/index.js";
import { DaemonError, errorCode } from "../daemon/index.js";
import { ensurePrivateDir } from "../daemon/private-dir.js";
import type { StartedDaemon } from "./daemon-link.js";

const MAX_LOG_BYTES = 1024 * 1024;

export interface SpawnDaemonOptions {
    execPath : string;
    script   : string;
    flags    : string[];
    logFile  : string;
    platform?: NodeJS.Platform;
    uid?     : number | undefined;
    spawn?   : typeof nodeSpawn;
}

function openLog(logFile: string): number {
    try {
        const stats = lstatSync(logFile);

        // A directory opens for appending on Windows.
        if (stats.isDirectory()) {
            throw new DaemonError(
                `Cannot open the daemon log ${logFile}: it is a directory. Check its permissions.`,
            );
        }

        if (stats.size > MAX_LOG_BYTES) truncateSync(logFile, 0);
    } catch (error) {
        if (error instanceof DaemonError) throw error;

        if (errorCode(error) !== "ENOENT") {
            throw new DaemonError(
                `Cannot open the daemon log ${logFile}: ${error instanceof Error ? error.message : String(error)}. Check its permissions.`,
            );
        }
    }

    // O_NOFOLLOW is absent on Windows.
    const flags =
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);

    try {
        return openSync(logFile, flags, 0o600);
    } catch (error) {
        throw new DaemonError(
            `Cannot open the daemon log ${logFile}: ${error instanceof Error ? error.message : String(error)}. Check its permissions.`,
        );
    }
}

export async function spawnDaemonProcess(options: SpawnDaemonOptions): Promise<StartedDaemon> {
    const spawn = options.spawn ?? nodeSpawn;
    const platform = options.platform ?? process.platform;

    await ensurePrivateDir(
        pathFor(platform).dirname(options.logFile),
        platform,
        options.uid ?? process.getuid?.(),
    );
    const log = openLog(options.logFile);

    try {
        const child = spawn(options.execPath, [options.script, "daemon", ...options.flags], {
            detached   : true,
            stdio      : ["ignore", log, log],
            windowsHide: true,
        });
        const exited = new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            child.once("error", () => resolve());
        });

        child.unref();

        return { exited };
    } finally {
        closeSync(log);
    }
}
