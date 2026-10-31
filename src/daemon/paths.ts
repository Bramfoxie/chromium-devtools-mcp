import { createHash } from "node:crypto";
import os from "node:os";
import { APP_NAME, defaultProfileDir, pathFor } from "../config/index.js";
const SOCKET_FILE = "daemon.sock";
const TOKEN_FILE = "daemon.token";
const UNIX_RUNTIME_ROOT = "/tmp";
const PIPE_SUFFIX_LENGTH = 16;

export interface DaemonPathContext {
  env     : NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir : string;
  uid     : number | undefined;
  username: string;
}

export function currentUsername(
  env: NodeJS.ProcessEnv,
  lookup: () => { username: string } = () => os.userInfo(),
): string {
  try {
    return lookup().username;
  } catch {
    return env.USER || env.USERNAME || "user";
  }
}

export function currentPathContext(): DaemonPathContext {
  return {
    env     : process.env,
    platform: process.platform,
    homedir : os.homedir(),
    uid     : process.getuid?.(),
    username: currentUsername(process.env),
  };
}

export function runtimeDir({ platform, uid, username }: DaemonPathContext): string | undefined {
  if (platform === "win32") return undefined;

  return pathFor(platform).join(UNIX_RUNTIME_ROOT, `${APP_NAME}-${uid ?? username}`);
}

export function socketPath(context: DaemonPathContext, token: string): string {
  const dir = runtimeDir(context);

  if (dir !== undefined) return pathFor(context.platform).join(dir, SOCKET_FILE);

  const user = context.username.replace(/[\\/]/g, "_");
  const secret = createHash("sha256").update(token).digest("hex").slice(0, PIPE_SUFFIX_LENGTH);

  return `\\\\.\\pipe\\${APP_NAME}-${user}-${secret}`;
}

export function tokenPath({ env, platform, homedir }: DaemonPathContext): string {
  const p = pathFor(platform);

  return p.join(p.dirname(defaultProfileDir({ env, platform, homedir })), TOKEN_FILE);
}

export function maxSocketPathBytes(platform: NodeJS.Platform): number {
  if (platform === "win32") return Number.POSITIVE_INFINITY;

  return platform === "darwin" ? 103 : 107;
}
