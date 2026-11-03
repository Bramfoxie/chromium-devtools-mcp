import { SERVER_NAME, type ServerEntry } from "./entry.js";
import { detectEol, type MergeResult } from "./merge-result.js";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serialize(root: Json, eol: string): string {
    return `${JSON.stringify(root, null, 2)}\n`.replace(/\n/g, eol);
}

export function mergeJson(
    text : string | undefined,
    entry: ServerEntry | undefined,
    extra: Json = {},
): MergeResult {
    const blank = text === undefined || text.trim() === "";
    let root: unknown = {};

    if (!blank) {
        try {
            root = JSON.parse(text);
        } catch {
            return { status: "invalid", reason: "the file is not valid JSON" };
        }
    }

    if (!isObject(root)) return { status: "invalid", reason: "the top level is not a JSON object" };

    const servers = root.mcpServers;

    if (servers !== undefined && !isObject(servers)) {
        return { status: "invalid", reason: "mcpServers is not a JSON object" };
    }

    const current = servers?.[SERVER_NAME];

    if (entry === undefined) {
        if (servers === undefined || !(SERVER_NAME in servers)) return { status: "unchanged" };

        const rest = { ...servers };

        delete rest[SERVER_NAME];

        return {
            status: "changed",
            action: "removed",
            text  : serialize({ ...root, mcpServers: rest }, detectEol(text ?? "")),
        };
    }

    const next = { ...(isObject(current) ? current : {}), ...extra, ...entry };

    if (current !== undefined && JSON.stringify(current) === JSON.stringify(next)) {
        return { status: "unchanged" };
    }

    return {
        status: "changed",
        action: current === undefined ? "added" : "updated",
        text  : serialize({ ...root, mcpServers: { ...servers, [SERVER_NAME]: next } }, detectEol(text ?? "")),
    };
}
