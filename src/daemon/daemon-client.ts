import { z } from "zod";
import { IpcClient } from "./client.js";
import { DaemonConfigMismatchError, DaemonError, DaemonNotRunningError } from "./errors.js";
import { currentLayout, type DaemonLayout } from "./layout.js";
import { readToken } from "./token.js";

const identitySchema = z.object({ daemon: z.object({ browser: z.string(), mode: z.string() }) });

export interface ConnectToDaemonOptions {
  clientName       : string;
  expect?          : { browser: string; mode: string };
  layout?          : DaemonLayout;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export async function connectToDaemon(options: ConnectToDaemonOptions): Promise<IpcClient> {
  const layout = options.layout ?? currentLayout();
  let token: string | undefined;

  try {
    token = await readToken(layout.tokenFile);
  } catch (error) {
    throw new DaemonError(
      `Cannot read the daemon token file ${layout.tokenFile} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Check its permissions.`,
    );
  }

  if (!token) throw new DaemonNotRunningError();

  const client = await IpcClient.connect({
    socketPath      : layout.socketPath(token),
    token,
    clientName      : options.clientName,
    connectTimeoutMs: options.connectTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  const expected = options.expect;

  if (!expected) return client;

  const running = identitySchema.safeParse(client.helloResult);
  const same =
    running.success &&
    running.data.daemon.browser === expected.browser &&
    running.data.daemon.mode === expected.mode;

  if (same) return client;

  await client.close();

  throw new DaemonConfigMismatchError(
    running.success
      ? `browser ${running.data.daemon.browser} in ${running.data.daemon.mode} mode`
      : "an unknown configuration",
    `browser ${expected.browser} in ${expected.mode} mode`,
  );
}
