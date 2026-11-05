import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The version of this package, or "unknown" when package.json cannot be read.
export function ownVersion(): string {
    try {
        const file = fileURLToPath(new URL("../../package.json", import.meta.url));
        const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;

        return typeof version === "string" ? version : "unknown";
    } catch {
        return "unknown";
    }
}
