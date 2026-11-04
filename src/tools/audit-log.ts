import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { redactUrl } from "./capture/redact.js";

const CLIP = 100;

const MAX_DEPTH = 3;

const MAX_ITEMS = 10;

const MAX_ERROR_CHARS = 300;

// What the agent types or runs may hold a secret, so only its length and a short fingerprint are kept.
const CONTENT_KEYS = new Set(["text", "value", "expression", "html", "prompttext"]);

const SECRET_KEY = /pass|secret|token|key|auth|cookie|credential/i;

const URL_KEYS = new Set(["url", "urlcontains", "urlregex", "origin", "href"]);

export interface AuditEntry {
    time      : string;
    tool      : string;
    tab?      : string;
    url?      : string;
    args      : unknown;
    outcome   : "ok" | "error";
    error?    : string;
    durationMs: number;
}

export interface AuditSink {
    write(line: string): void;
}

function fingerprint(text: string): string {
    return `<${[...text].length} chars, sha256 ${createHash("sha256").update(text).digest("hex").slice(0, 12)}>`;
}

function clip(text: string, limit = CLIP): string {
    const single = text.replace(/\s+/g, " ");

    return single.length <= limit ? single : `${single.slice(0, limit)}...`;
}

function summarizeValue(key: string, value: unknown, depth: number): unknown {
    const name = key.toLowerCase();

    if (SECRET_KEY.test(key)) return "<redacted>";

    if (typeof value === "string") {
        if (CONTENT_KEYS.has(name)) return fingerprint(value);

        return URL_KEYS.has(name) ? clip(redactUrl(value), 200) : clip(value);
    }

    if (typeof value === "number" || typeof value === "boolean" || value === null) return value;

    if (Array.isArray(value)) {
        if (depth >= MAX_DEPTH) return `<${value.length} items>`;

        const shown = value.slice(0, MAX_ITEMS).map((item) => summarizeValue(key, item, depth + 1));

        return value.length > MAX_ITEMS ? [...shown, `<${value.length - MAX_ITEMS} more>`] : shown;
    }

    if (typeof value === "object") {
        if (depth >= MAX_DEPTH) return "<object>";

        return summarizeArgs(value, depth + 1);
    }

    return undefined;
}

export function summarizeArgs(args: unknown, depth = 0): Record<string, unknown> {
    if (typeof args !== "object" || args === null || Array.isArray(args)) return {};

    const summary: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(args)) {
        const shaped = summarizeValue(key, value, depth);

        if (shaped !== undefined) summary[key] = shaped;
    }

    return summary;
}

export function auditLine(entry: AuditEntry): string {
    return JSON.stringify({
        ...entry,
        ...(entry.error === undefined ? {} : { error: clip(entry.error, MAX_ERROR_CHARS) }),
    });
}

export class AuditLog {
    private warned = false;

    constructor(
        private readonly sink: AuditSink,
        private readonly warn: (message: string) => void,
    ) {}

    record(entry: AuditEntry): void {
        try {
            this.sink.write(`${auditLine(entry)}\n`);
        } catch (error) {
            if (this.warned) return;

            this.warned = true;
            this.warn(
                `could not write the audit log: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}

export function fileAuditSink(file: string): AuditSink {
    let prepared = false;

    return {
        write: (line) => {
            if (!prepared) {
                mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
                prepared = true;
            }

            appendFileSync(file, line, { mode: 0o600 });
        },
    };
}
