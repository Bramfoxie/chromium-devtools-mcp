export class DaemonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonError";
  }
}

export class AlreadyRunningError extends DaemonError {
  constructor(readonly socketPath: string) {
    super(
      `Another chromium-devtools-mcp daemon is already running on ${socketPath}. ` +
        "Connect to it instead of starting a new one.",
    );
    this.name = "AlreadyRunningError";
  }
}
