import { describe, expect, it } from "vitest";
import { buildEntry } from "../src/install/entry.js";
import { mergeToml } from "../src/install/merge-toml.js";

const entry = buildEntry("linux", []);
const SECTION = `[mcp_servers.chromium-devtools]
command = "npx"
args = ["-y", "chromium-devtools-mcp"]
`;

function changed(result: ReturnType<typeof mergeToml>): string {
    if (result.status !== "changed") throw new Error(`expected a change, got ${result.status}`);

    return result.text;
}

describe("mergeToml", () => {
    it("creates the file content", () => {
        expect(changed(mergeToml(undefined, entry))).toBe(SECTION);
    });

    it("appends after existing content and leaves it byte-identical", () => {
        const text = `# my settings\nmodel = "x"\n\n[mcp_servers.other]\ncommand = "y"\n`;
        const out = changed(mergeToml(text, entry));

        expect(out).toBe(`${text}\n${SECTION}`);
    });

    it("appends to a file without a final newline", () => {
        expect(changed(mergeToml("a = 1", entry))).toBe(`a = 1\n\n${SECTION}`);
    });

    it("is idempotent", () => {
        const first = changed(mergeToml("a = 1\n", entry));

        expect(mergeToml(first, entry)).toEqual({ status: "unchanged" });
    });

    it("updates only its own table between other tables", () => {
        const text = `[mcp_servers.chromium-devtools]
command = "old"
args = []

# keep me
[mcp_servers.other]
command = "y"
`;
        const out = changed(mergeToml(text, buildEntry("linux", ["--headless"])));

        expect(out).toBe(`[mcp_servers.chromium-devtools]
command = "npx"
args = ["-y", "chromium-devtools-mcp", "--headless"]

# keep me
[mcp_servers.other]
command = "y"
`);
    });

    it("keeps a sub table of its own entry", () => {
        const text = `${SECTION.replace("npx", "old")}\n[mcp_servers.chromium-devtools.env]\nK = "v"\n`;
        const out = changed(mergeToml(text, entry));

        expect(out).toBe(`${SECTION}\n[mcp_servers.chromium-devtools.env]\nK = "v"\n`);
    });

    it("recognizes a quoted key and a trailing comment on the header", () => {
        const text = `[mcp_servers."chromium-devtools"] # ours\ncommand = "old"\n`;

        expect(changed(mergeToml(text, entry))).toBe(SECTION);
    });

    it("keeps CRLF line endings", () => {
        const out = changed(mergeToml("a = 1\r\n", entry));

        expect(out).toBe(`a = 1\r\n\r\n${SECTION.replace(/\n/g, "\r\n")}`);
    });

    it("writes the Windows command form", () => {
        expect(changed(mergeToml("", buildEntry("win32", [])))).toBe(`[mcp_servers.chromium-devtools]
command = "cmd"
args = ["/c", "npx", "-y", "chromium-devtools-mcp"]
`);
    });

    it("refuses a duplicated table", () => {
        expect(mergeToml(`${SECTION}\n${SECTION}`, entry)).toMatchObject({ status: "invalid" });
    });

    it("removes its table and restores the original text", () => {
        const original = "a = 1\n\n[x]\nb = 2\n";
        const installed = changed(mergeToml(original, entry));

        expect(changed(mergeToml(installed, undefined))).toBe(original);
        expect(mergeToml(original, undefined)).toEqual({ status: "unchanged" });
    });

    it("removes a table from the middle", () => {
        const text = `${SECTION}\n[x]\nb = 2\n`;

        expect(changed(mergeToml(text, undefined))).toBe("[x]\nb = 2\n");
    });
});
