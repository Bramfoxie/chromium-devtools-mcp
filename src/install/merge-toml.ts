import { SERVER_NAME, type ServerEntry } from "./entry.js";
import { detectEol, type MergeResult } from "./merge-result.js";

const OWN_HEADER = new RegExp(
    `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${SERVER_NAME}|"${SERVER_NAME}"|'${SERVER_NAME}')\\s*\\]\\s*(?:#.*)?$`,
);
const ANY_HEADER = /^\s*\[\[?\s*[A-Za-z0-9_"'-][^\]=]*\]\]?\s*(?:#.*)?$/;

export function tomlSection(entry: ServerEntry): string[] {
    return [
        `[mcp_servers.${SERVER_NAME}]`,
        `command = ${JSON.stringify(entry.command)}`,
        `args = [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    ];
}

function splitLines(text: string): string[] {
    return text === "" ? [] : text.split(/\r?\n/);
}

export function mergeToml(text: string | undefined, entry: ServerEntry | undefined): MergeResult {
    const source = text ?? "";
    const eol = detectEol(source);
    const lines = splitLines(source);
    const starts = lines.flatMap((line, index) => (OWN_HEADER.test(line) ? [index] : []));

    if (starts.length > 1) {
        return { status: "invalid", reason: `the table [mcp_servers.${SERVER_NAME}] appears more than once` };
    }

    const [start] = starts;

    if (start === undefined) {
        if (entry === undefined) return { status: "unchanged" };

        const head = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
        const gap = head.length > 0 ? [""] : [];

        return {
            status: "changed",
            action: "added",
            text  : [...head, ...gap, ...tomlSection(entry), ""].join(eol),
        };
    }

    let stop = start + 1;

    while (stop < lines.length && !ANY_HEADER.test(lines[stop] ?? "")) stop += 1;

    let bodyEnd = stop;

    while (bodyEnd > start + 1 && /^\s*(?:#.*)?$/.test(lines[bodyEnd - 1] ?? "")) bodyEnd -= 1;

    if (entry === undefined) {
        const before = lines.slice(0, start);
        let resume = bodyEnd;

        while (resume < lines.length && (lines[resume] ?? "").trim() === "") resume += 1;

        const after = lines.slice(resume);

        if (after.every((line) => line === "")) {
            while (before.length > 0 && before[before.length - 1] === "") before.pop();

            return {
                status: "changed",
                action: "removed",
                text  : before.length === 0 ? "" : `${before.join(eol)}${eol}`,
            };
        }

        return { status: "changed", action: "removed", text: [...before, ...after].join(eol) };
    }

    const wanted = tomlSection(entry);
    const existing = lines.slice(start, bodyEnd);

    const same =
        existing.length === wanted.length && existing.every((l, i) => l.trim() === wanted[i]);

    if (same) {
        return { status: "unchanged" };
    }

    return {
        status: "changed",
        action: "updated",
        text  : [...lines.slice(0, start), ...wanted, ...lines.slice(bodyEnd)].join(eol),
    };
}
