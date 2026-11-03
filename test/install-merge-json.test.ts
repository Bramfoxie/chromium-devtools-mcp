import { describe, expect, it } from "vitest";
import { buildEntry } from "../src/install/entry.js";
import { mergeJson } from "../src/install/merge-json.js";

const entry = buildEntry("linux", []);

function changed(result: ReturnType<typeof mergeJson>): string {
    if (result.status !== "changed") throw new Error(`expected a change, got ${result.status}`);

    return result.text;
}

describe("buildEntry", () => {
    it("runs the package through npx", () => {
        expect(entry).toEqual({ command: "npx", args: ["-y", "chromium-devtools-mcp"] });
    });

    it("wraps npx in cmd on Windows and appends server flags", () => {
        expect(buildEntry("win32", ["--read-only"])).toEqual({
            command: "cmd",
            args   : ["/c", "npx", "-y", "chromium-devtools-mcp", "--read-only"],
        });
    });
});

describe("mergeJson", () => {
    it("creates the document from a missing or blank file", () => {
        const golden = `{
  "mcpServers": {
    "chromium-devtools": {
      "command": "npx",
      "args": [
        "-y",
        "chromium-devtools-mcp"
      ]
    }
  }
}
`;

        expect(changed(mergeJson(undefined, entry))).toBe(golden);
        expect(changed(mergeJson("  \n", entry))).toBe(golden);
    });

    it("keeps other keys and servers", () => {
        const text = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } });
        const out = JSON.parse(changed(mergeJson(text, entry)));

        expect(out.theme).toBe("dark");
        expect(out.mcpServers.other).toEqual({ command: "x" });
        expect(out.mcpServers["chromium-devtools"]).toEqual(entry);
    });

    it("is idempotent", () => {
        const first = changed(mergeJson("{}", entry));

        expect(mergeJson(first, entry)).toEqual({ status: "unchanged" });
    });

    it("updates its own entry in place and keeps user additions", () => {
        const text = JSON.stringify({
            mcpServers: {
                a                  : {},
                "chromium-devtools": { command: "old", args: [], env: { K: "v" } },
                z                  : {},
            },
        });
        const result = mergeJson(text, buildEntry("linux", ["--headless"]));
        const out = JSON.parse(changed(result));

        expect(result).toMatchObject({ action: "updated" });
        expect(Object.keys(out.mcpServers)).toEqual(["a", "chromium-devtools", "z"]);
        expect(out.mcpServers["chromium-devtools"]).toEqual({
            command: "npx",
            args   : ["-y", "chromium-devtools-mcp", "--headless"],
            env    : { K: "v" },
        });
    });

    it("adds the extra fields of a client", () => {
        const out = JSON.parse(changed(mergeJson("{}", entry, { type: "stdio" })));

        expect(out.mcpServers["chromium-devtools"].type).toBe("stdio");
    });

    it("refuses files it cannot safely edit", () => {
        expect(mergeJson("{ nope", entry)).toMatchObject({ status: "invalid" });
        expect(mergeJson("[]", entry)).toMatchObject({ status: "invalid" });
        expect(mergeJson('{"mcpServers": []}', entry)).toMatchObject({ status: "invalid" });
    });

    it("keeps CRLF line endings", () => {
        const text = changed(mergeJson('{\r\n  "a": 1\r\n}\r\n', entry));

        expect(text).toContain("\r\n");
        expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    });

    it("removes only its own entry", () => {
        const text = JSON.stringify({
            mcpServers: { other: { command: "x" }, "chromium-devtools": entry },
        });
        const out = JSON.parse(changed(mergeJson(text, undefined)));

        expect(out.mcpServers).toEqual({ other: { command: "x" } });
        expect(mergeJson("{}", undefined)).toEqual({ status: "unchanged" });
    });
});
