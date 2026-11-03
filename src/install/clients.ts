import { pathFor } from "../config/paths.js";
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
    file?  : (context: ClientContext) => string;
    merge? : (text: string | undefined, entry: ServerEntry | undefined) => MergeResult;
    preview: (entry: ServerEntry) => string;
}

function absoluteOr(value: string | undefined, fallback: string, context: ClientContext): string {
    return value && pathFor(context.platform).isAbsolute(value) ? value : fallback;
}

function jsonPreview(entry: ServerEntry, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ mcpServers: { [SERVER_NAME]: { ...extra, ...entry } } }, null, 2);
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
];
