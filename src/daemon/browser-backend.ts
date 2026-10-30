export interface TargetInfo {
  targetId: string;
  url: string;
  title: string;
  // undefined for the default browser context
  contextId: string | undefined;
}

export interface BackendSession {
  send(method: string, params: object | undefined, timeoutMs?: number): Promise<unknown>;
  on(event: string, handler: (params: unknown) => void): () => void;
  detach(): Promise<void>;
}

export interface BrowserBackend {
  createContext(): Promise<string>;
  disposeContext(contextId: string): Promise<void>;
  // opens the page in the background
  createTarget(url: string, contextId: string | undefined): Promise<string>;
  closeTarget(targetId: string): Promise<void>;
  // page targets only
  listTargets(): Promise<TargetInfo[]>;
  attach(targetId: string): Promise<BackendSession>;
  onTargetDestroyed(handler: (targetId: string) => void): () => void;
  // fires when the connection ends, including after close()
  onDisconnected(handler: () => void): () => void;
  // closes the connection to the browser, not the browser itself
  close(): Promise<void>;
}
