import type net from "node:net";
import { AlreadyRunningError, DaemonError } from "./errors.js";
import { maxSocketPathBytes } from "./paths.js";
import { ensurePrivateDir } from "./private-dir.js";
import { realInstanceIO } from "./socket-io.js";

const LOCK_ATTEMPTS = 40;
const LOCK_RETRY_MS = 50;

export interface ListeningServer {
  close(): Promise<void>;
}

export interface InstanceIO {
  listen: (
    path: string,
    onConnection: (socket: net.Socket) => void,
    restrict: boolean,
  ) => Promise<ListeningServer>;
  probe       : (path: string) => Promise<"alive" | "stale">;
  removeSocket: (path: string) => Promise<void>;
  lockCleanup : (path: string) => Promise<(() => Promise<void>) | undefined>;
  sleep       : (ms: number) => Promise<void>;
}

export interface InstanceOptions {
  socketPath: string;
  runtimeDir: string | undefined;
  platform  : NodeJS.Platform;
  uid       : number | undefined;
}

export interface InstanceHandle {
  release(): Promise<void>;
}

export interface InstanceDeps {
  io       : InstanceIO;
  ensureDir: (dir: string) => Promise<void>;
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

export async function acquireInstance(
  options: InstanceOptions,
  onConnection: (socket: net.Socket) => void,
  overrides: Partial<InstanceDeps> = {},
): Promise<InstanceHandle> {
  const io = overrides.io ?? realInstanceIO;
  const ensureDir =
    overrides.ensureDir ?? ((dir: string) => ensurePrivateDir(dir, options.platform, options.uid));
  const { socketPath, platform } = options;
  const unix = platform !== "win32";
  const limit = maxSocketPathBytes(platform);

  if (Buffer.byteLength(socketPath) > limit) {
    throw new DaemonError(
      `The daemon socket path is too long (${Buffer.byteLength(socketPath)} bytes, limit ${limit}). ` +
        "Use a user name or home directory with a shorter path.",
    );
  }

  if (options.runtimeDir) await ensureDir(options.runtimeDir);

  const listen = async (): Promise<ListeningServer | "in-use"> => {
    try {
      return await io.listen(socketPath, onConnection, unix);
    } catch (error) {
      if (isAddressInUse(error)) return "in-use";

      throw new DaemonError(`Cannot listen on the daemon socket: ${(error as Error).message}.`);
    }
  };

  const claim = async (): Promise<ListeningServer> => {
    const first = await listen();

    if (first !== "in-use") return first;
    if (!unix) throw new AlreadyRunningError(socketPath);

    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      const unlock = await io.lockCleanup(socketPath);

      if (!unlock) {
        await io.sleep(LOCK_RETRY_MS);
        continue;
      }

      try {
        const retry = await listen();

        if (retry !== "in-use") return retry;
        if ((await io.probe(socketPath)) === "alive") throw new AlreadyRunningError(socketPath);

        await io.removeSocket(socketPath);
        const last = await listen();

        if (last === "in-use") throw new AlreadyRunningError(socketPath);

        return last;
      } finally {
        await unlock();
      }
    }

    throw new DaemonError(
      "Another daemon is starting right now and holds the start lock. Try again in a moment.",
    );
  };

  const server = await claim();
  let released: Promise<void> | undefined;

  return { release: () => (released ??= server.close()) };
}
