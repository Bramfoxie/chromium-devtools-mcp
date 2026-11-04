import type { PermissionGrant } from "./permissions.js";
export interface TargetInfo {
    targetId : string;
    url      : string;
    title    : string;
    // undefined for the default browser context
    contextId: string | undefined;
}

export interface BackendSession {
    send(method: string, params: object | undefined, timeoutMs?: number): Promise<unknown>;
    on(event: string, handler: (params: unknown) => void): () => void;
    detach(): Promise<void>;
}

export interface ChildTargetInfo {
    targetId : string;
    sessionId: string;
    frameId  : string | undefined;
    url      : string;
}

export interface ChildSessionOptions {
    onDetached(child: ChildTargetInfo): void;
    onAttached?(child: FrameChildSession): Promise<void>;
}

export interface FrameChildSession extends BackendSession {
    child: ChildTargetInfo;
}

export interface ChildSessionHandle {
    children(): FrameChildSession[];
    takeUnmatched(): FrameChildSession[];
    confirmMatched(sessionId: string): void;
    droppedCount(): number;
    detachAll(): Promise<void>;
}

export const MAX_CHILD_SESSIONS_PER_TAB = 50;

export const MAX_CHILD_ATTACH_DEPTH = 5;

export interface BrowserBackend {
    createContext(): Promise<string>;
    disposeContext(contextId: string): Promise<void>;
    // opens the page in the background
    createTarget(url: string, contextId: string | undefined): Promise<string>;
    closeTarget(targetId: string): Promise<void>;
    // page targets only
    listTargets(): Promise<TargetInfo[]>;
    attach(targetId: string): Promise<BackendSession>;
    setPermission(grant: PermissionGrant): Promise<void>;
    resetPermissions(contextId: string | undefined): Promise<void>;
    attachChildren(
        session: BackendSession,
        options: ChildSessionOptions,
    ): Promise<ChildSessionHandle>;
    onTargetDestroyed(handler: (targetId: string) => void): () => void;
    onDisconnected(handler: () => void): () => void;
    // closes the connection to the browser, not the browser itself
    close(): Promise<void>;
}
