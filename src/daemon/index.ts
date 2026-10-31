export {
    AlreadyRunningError,
    DaemonConfigMismatchError,
    DaemonError,
    DaemonNotRunningError,
    errorCode,
    IpcClosedError,
    IpcTimeoutError,
    ProtocolViolationError,
    RpcError,
} from "./errors.js";
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
export type { BackendSession, BrowserBackend, TargetInfo } from "./browser-backend.js";
export { Daemon, type DaemonOptions } from "./daemon.js";
export { createRequestHandler } from "./handler.js";
export { checkCall, checkEvent, normalizeUrl, type PolicyOptions } from "./method-policy.js";
export {
    ClientSession,
    type Emit,
    SessionRegistry,
    type SessionOptions,
    type TabInfo,
    type TabScope,
} from "./sessions.js";
export { CdpBackend } from "./cdp-backend.js";
export { connectToDaemon, type ConnectToDaemonOptions } from "./daemon-client.js";
export type { DaemonState, DaemonStatus } from "./handler.js";
export { currentLayout, type DaemonLayout } from "./layout.js";
export {
    type DaemonIdentity,
    daemonIdentity,
    describeIdentity,
    differingFields,
    type IdentityField,
} from "./identity.js";
export {
    approvalMessage,
    type BrowserConnector,
    type BrowserHandle,
    type ConnectHooks,
    type ConnectorDeps,
    createConnector,
    type DaemonOutcome,
    type RunDeps,
    runDaemon,
    type RunningDaemon,
    type StopReason,
} from "./runner.js";
