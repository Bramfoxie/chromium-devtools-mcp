import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, constants, lstatSync, openSync, truncateSync } from "node:fs";
import path from "node:path";
import { ensurePrivateDir } from "../daemon/private-dir.js";
import type { StartedDaemon } from "./daemon-link.js";

const MAX_LOG_BYTES = 1024 * 1024;

export interface SpawnDaemonOptions {
  execPath: string;
  script: string;
  flags: string[];
  logFile: string;
  platform?: NodeJS.Platform;
  uid?: number | undefined;
  spawn?: typeof nodeSpawn;
}

function openLog(logFile: string): number {
  try {
    if (lstatSync(logFile).size > MAX_LOG_BYTES) truncateSync(logFile, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);
  return openSync(logFile, flags, 0o600);
}

export async function spawnDaemonProcess(options: SpawnDaemonOptions): Promise<StartedDaemon> {
  const spawn = options.spawn ?? nodeSpawn;
  await ensurePrivateDir(
    path.dirname(options.logFile),
    options.platform ?? process.platform,
    "uid" in options ? options.uid : process.getuid?.(),
  );
  const log = openLog(options.logFile);
  try {
    const child = spawn(options.execPath, [options.script, "daemon", ...options.flags], {
      detached: true,
      stdio: ["ignore", log, log],
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
