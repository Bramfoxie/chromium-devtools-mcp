export type MergeResult =
    | { status: "invalid"; reason: string }
    | { status: "unchanged" }
    | { status: "changed"; action: "added" | "updated" | "removed"; text: string };

export function detectEol(text: string): string {
    return text.includes("\r\n") ? "\r\n" : "\n";
}
