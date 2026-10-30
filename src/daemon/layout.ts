import type { InstanceOptions } from "./lock.js";
import {
  currentPathContext,
  type DaemonPathContext,
  runtimeDir,
  socketPath,
  tokenPath,
} from "./paths.js";

export interface DaemonLayout {
  tokenFile: string;
  platform : NodeJS.Platform;
  uid      : number | undefined;
  socketPath(token: string): string;
  instance(token: string): InstanceOptions;
}

export function currentLayout(context: DaemonPathContext = currentPathContext()): DaemonLayout {
  return {
    tokenFile : tokenPath(context),
    platform  : context.platform,
    uid       : context.uid,
    socketPath: (token) => socketPath(context, token),
    instance  : (token) => ({
      socketPath: socketPath(context, token),
      runtimeDir: runtimeDir(context),
      platform  : context.platform,
      uid       : context.uid,
    }),
  };
}
