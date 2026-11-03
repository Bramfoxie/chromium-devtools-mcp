export function writeLogLine(message: string): void {
    process.stderr.write(`chromium-devtools-mcp: ${message}\n`);
}
