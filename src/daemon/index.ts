export { AlreadyRunningError, DaemonError } from "./errors.js";
export {
  acquireInstance,
  type InstanceDeps,
  type InstanceHandle,
  type InstanceIO,
  type InstanceOptions,
  type ListeningServer,
} from "./lock.js";
export {
  currentPathContext,
  currentUsername,
  type DaemonPathContext,
  maxSocketPathBytes,
  runtimeDir,
  socketPath,
  tokenPath,
} from "./paths.js";
export { type DirIO, type DirStat, ensurePrivateDir } from "./private-dir.js";
export { ensureToken, generateToken, readToken, tokensMatch } from "./token.js";
