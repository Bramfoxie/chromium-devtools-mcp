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
export { IpcClosedError, IpcTimeoutError, ProtocolViolationError, RpcError } from "./errors.js";
export { IpcClient, type IpcConnectOptions, type IpcEventHandler } from "./client.js";
export {
  encodeMessage,
  ErrorCode,
  LineDecoder,
  MAX_LINE_BYTES,
  type HelloParams,
  type Request,
  type Response,
  type ServerEvent,
} from "./protocol.js";
export {
  acceptConnection,
  type AcceptOptions,
  type ClientConnection,
  type IncomingRequest,
  type RequestHandler,
} from "./server.js";
