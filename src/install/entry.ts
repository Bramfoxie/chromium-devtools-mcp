export const SERVER_NAME = "chromium-devtools";

export const PACKAGE_NAME = "chromium-devtools-mcp";

export interface ServerEntry {
    command: string;
    args   : string[];
}

export function buildEntry(platform: NodeJS.Platform, serverFlags: string[]): ServerEntry {
    const args = ["-y", PACKAGE_NAME, ...serverFlags];

    return platform === "win32"
        ? { command: "cmd", args: ["/c", "npx", ...args] }
        : { command: "npx", args };
}
