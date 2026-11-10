import { baseDir, pathFor } from "../config/paths.js";
import { SERVER_NAME, type ServerEntry } from "./entry.js";
import { type MergeResult } from "./merge-result.js";
import { mergeJson } from "./merge-json.js";
import { mergeToml, tomlSection } from "./merge-toml.js";

export interface ClientContext {
    home    : string;
    platform: NodeJS.Platform;
    env     : NodeJS.ProcessEnv;
}

export interface ClientTarget {
    name   : string;
    label  : string;
    inAll? : boolean;
    file?  : (context: ClientContext) => string;
    merge? : (text: string | undefined, entry: ServerEntry | undefined) => MergeResult;
    preview: (entry: ServerEntry) => string;
}

function absoluteOr(value: string | undefined, fallback: string, context: ClientContext): string {
    return value && pathFor(context.platform).isAbsolute(value) ? value : fallback;
}

function jsonPreview(
    entry: ServerEntry,
    extra: Record<string, unknown> = {},
    key = "mcpServers",
): string {
    return JSON.stringify({ [key]: { [SERVER_NAME]: { ...extra, ...entry } } }, null, 2);
}

function userConfigDir(context: ClientContext): string {
    const p = pathFor(context.platform);

    if (context.platform === "win32") {
        return baseDir(context.env.APPDATA, p.join(context.home, "AppData", "Roaming"), context.platform);
    }

    if (context.platform === "darwin") return p.join(context.home, "Library", "Application Support");

    return baseDir(context.env.XDG_CONFIG_HOME, p.join(context.home, ".config"), context.platform);
}

function codeTarget(name: string, label: string, folder: string): ClientTarget {
    return {
        name,
        label,
        inAll  : false,
        file   : (context) => pathFor(context.platform).join(userConfigDir(context), folder, "User", "mcp.json"),
        merge  : (text, entry) => mergeJson(text, entry, { type: "stdio" }, "servers"),
        preview: (entry) => jsonPreview(entry, { type: "stdio" }, "servers"),
    };
}

function homeJsonTarget(name: string, label: string, ...segments: string[]): ClientTarget {
    return {
        name,
        label,
        inAll  : false,
        file   : (context) => pathFor(context.platform).join(context.home, ...segments),
        merge  : (text, entry) => mergeJson(text, entry),
        preview: (entry) => jsonPreview(entry),
    };
}

export const CLIENTS: ClientTarget[] = [
    {
        name : "claude-code",
        label: "Claude Code",
        file : (context) => {
            const p = pathFor(context.platform);
            const dir = absoluteOr(context.env.CLAUDE_CONFIG_DIR, context.home, context);

            return p.join(dir, ".claude.json");
        },
        merge  : (text, entry) => mergeJson(text, entry, { type: "stdio" }),
        preview: (entry) => jsonPreview(entry, { type: "stdio" }),
    },
    {
        name   : "cursor",
        label  : "Cursor",
        file   : (context) => pathFor(context.platform).join(context.home, ".cursor", "mcp.json"),
        merge  : (text, entry) => mergeJson(text, entry),
        preview: (entry) => jsonPreview(entry),
    },
    {
        name : "codex",
        label: "Codex",
        file : (context) => {
            const p = pathFor(context.platform);
            const dir = absoluteOr(context.env.CODEX_HOME, p.join(context.home, ".codex"), context);

            return p.join(dir, "config.toml");
        },
        merge  : mergeToml,
        preview: (entry) => tomlSection(entry).join("\n"),
    },
    {
        name   : "cherry-studio",
        label  : "Cherry Studio",
        preview: (entry) => jsonPreview(entry),
    },
    {
        name : "claude-desktop",
        label: "Claude Desktop",
        inAll: false,
        file : (context) => pathFor(context.platform).join(
            userConfigDir(context),
            "Claude",
            "claude_desktop_config.json",
        ),
        merge  : (text, entry) => mergeJson(text, entry),
        preview: (entry) => jsonPreview(entry),
    },
    homeJsonTarget("windsurf", "Windsurf", ".codeium", "windsurf", "mcp_config.json"),
    homeJsonTarget("gemini-cli", "Gemini CLI", ".gemini", "settings.json"),
    codeTarget("vscode", "VS Code", "Code"),
    codeTarget("vscode-insiders", "VS Code Insiders", "Code - Insiders"),
];
