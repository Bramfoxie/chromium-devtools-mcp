const MAX_LOGGED_CHARS = 200;

export function logDaemon(message: string): void {
  process.stderr.write(`chromium-devtools-mcp: ${message}\n`);
}

export function quoted(text: string): string {
  const clipped = text.length > MAX_LOGGED_CHARS ? `${text.slice(0, MAX_LOGGED_CHARS)}...` : text;
  return JSON.stringify(clipped);
}

export function describeError(error: unknown): string {
  return quoted(error instanceof Error ? error.message : String(error));
}
