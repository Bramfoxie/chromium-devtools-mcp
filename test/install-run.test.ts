import { describe, expect, it } from "vitest";
import { parseInstallArgs } from "../src/install/args.js";
import { type InstallFs } from "../src/install/fs.js";
import { type InstallDeps, runInstall } from "../src/install/install.js";

function setup(files: Record<string, string> = {}, platform: NodeJS.Platform = "linux", env = {}) {
    const store = new Map(Object.entries(files));
    const writes: string[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const fs: InstallFs = {
        read     : (file) => store.get(file),
        writeFile: (file, text) => {
            writes.push(file);
            store.set(file, text);
        },
        copy: (from, to) => void store.set(to, store.get(from) ?? ""),
    };
    const home = platform === "win32" ? "C:\\Users\\u" : "/home/u";
    const deps: InstallDeps = {
        fs,
        home,
        platform,
        env,
        now: () => new Date("2026-01-02T03:04:05.678Z"),
        out: (text) => void out.push(text),
        err: (text) => void err.push(text),
    };

    return { store, writes, out, err, run: (argv: string[]) => runInstall(argv, deps) };
}

describe("parseInstallArgs", () => {
    it("separates installer flags from server flags", () => {
        expect(parseInstallArgs(["--client", "cursor", "--dry-run", "--read-only"])).toEqual({
            clients    : ["cursor"],
            dryRun     : true,
            remove     : false,
            serverFlags: ["--read-only"],
        });
    });

    it("accepts --client=name, repeats and all", () => {
        expect(parseInstallArgs(["--client=codex", "--client", "cursor"]).clients).toEqual(["codex", "cursor"]);
        expect(parseInstallArgs(["--client", "all"]).clients).toEqual([
            "claude-code",
            "cursor",
            "codex",
            "cherry-studio",
        ]);
    });

    it("lists the supported clients for an unknown or missing one", () => {
        expect(() => parseInstallArgs(["--client", "vim"])).toThrow(/Supported clients: claude-code, cursor, codex, cherry-studio, all/);
        expect(() => parseInstallArgs([])).toThrow(/--client is required/);
        expect(() => parseInstallArgs(["--client"])).toThrow(/needs a value/);
    });

    it("rejects server flags together with --remove", () => {
        expect(() => parseInstallArgs(["--client", "codex", "--remove", "--headless"])).toThrow(/--remove/);
    });
});

describe("runInstall", () => {
    it("writes the Cursor file, creating it", () => {
        const t = setup();

        expect(t.run(["--client", "cursor"])).toBe(0);
        expect(JSON.parse(t.store.get("/home/u/.cursor/mcp.json") ?? "")).toEqual({
            mcpServers: { "chromium-devtools": { command: "npx", args: ["-y", "chromium-devtools-mcp"] } },
        });
        expect(t.out.join("")).toContain("added");
    });

    it("writes Claude Code with an explicit stdio type and honors CLAUDE_CONFIG_DIR", () => {
        const t = setup({}, "linux", { CLAUDE_CONFIG_DIR: "/cfg" });

        t.run(["--client", "claude-code", "--read-only"]);

        expect(JSON.parse(t.store.get("/cfg/.claude.json") ?? "").mcpServers["chromium-devtools"]).toEqual({
            type   : "stdio",
            command: "npx",
            args   : ["-y", "chromium-devtools-mcp", "--read-only"],
        });
    });

    it("writes the Codex table under CODEX_HOME or ~/.codex", () => {
        const a = setup();
        const b = setup({}, "linux", { CODEX_HOME: "/codex" });

        a.run(["--client", "codex"]);
        b.run(["--client", "codex"]);

        expect(a.store.get("/home/u/.codex/config.toml")).toContain("[mcp_servers.chromium-devtools]");
        expect(b.store.get("/codex/config.toml")).toContain('args = ["-y", "chromium-devtools-mcp"]');
    });

    it("uses Windows paths and the cmd form", () => {
        const t = setup({}, "win32");

        t.run(["--client", "cursor"]);

        const text = t.store.get("C:\\Users\\u\\.cursor\\mcp.json") ?? "";

        expect(JSON.parse(text).mcpServers["chromium-devtools"].command).toBe("cmd");
    });

    it("backs up an existing file before modifying it", () => {
        const file = "/home/u/.cursor/mcp.json";
        const t = setup({ [file]: '{"mcpServers":{}}' });

        t.run(["--client", "cursor"]);

        expect(t.store.get(`${file}.bak-20260102T030405Z`)).toBe('{"mcpServers":{}}');
        expect(t.out.join("")).toContain("backup:");
    });

    it("does not back up when it creates the file", () => {
        const t = setup();

        t.run(["--client", "cursor"]);

        expect([...t.store.keys()]).toEqual(["/home/u/.cursor/mcp.json"]);
    });

    it("is idempotent: the second run writes and backs up nothing", () => {
        const t = setup();

        t.run(["--client", "codex"]);

        const before = new Map(t.store);
        const writes = t.writes.length;

        expect(t.run(["--client", "codex"])).toBe(0);
        expect(t.store).toEqual(before);
        expect(t.writes.length).toBe(writes);
        expect(t.out.join("")).toContain("already up to date");
    });

    it("updates its entry when the flags change", () => {
        const t = setup();

        t.run(["--client", "cursor"]);
        t.run(["--client", "cursor", "--headless"]);

        const text = t.store.get("/home/u/.cursor/mcp.json") ?? "";

        expect(JSON.parse(text).mcpServers["chromium-devtools"].args).toContain("--headless");
        expect(t.out.join("")).toContain("updated");
    });

    it("dry run prints the plan and writes nothing", () => {
        const t = setup({ "/home/u/.codex/config.toml": "a = 1\n" });

        expect(t.run(["--client", "all", "--dry-run"])).toBe(0);
        expect(t.writes).toEqual([]);
        expect([...t.store.keys()]).toEqual(["/home/u/.codex/config.toml"]);
        expect(t.out.join("")).toContain("dry run, would add chromium-devtools in /home/u/.cursor/mcp.json");
        expect(t.out.join("")).toContain("[mcp_servers.chromium-devtools]");
    });

    it("refuses an invalid file, keeps it and exits 1", () => {
        const file = "/home/u/.cursor/mcp.json";
        const t = setup({ [file]: "{ broken" });

        expect(t.run(["--client", "cursor"])).toBe(1);
        expect(t.store.get(file)).toBe("{ broken");
        expect(t.writes).toEqual([]);
        expect(t.err.join("")).toContain("not valid JSON");
        expect(t.err.join("")).toContain("Fix or move the file");
    });

    it("keeps going after one client fails and reflects it in the exit code", () => {
        const t = setup({ "/home/u/.cursor/mcp.json": "{ broken" });

        expect(t.run(["--client", "cursor", "--client", "codex"])).toBe(1);
        expect(t.store.has("/home/u/.codex/config.toml")).toBe(true);
    });

    it("reports a read error without throwing", () => {
        const t = setup();
        const deps: InstallDeps = {
            fs      : { read: () => { throw new Error("EACCES"); }, writeFile: () => undefined, copy: () => undefined },
            home    : "/h", platform: "linux", env     : {}, now     : () => new Date(0),
            out     : () => undefined, err     : (text) => void t.err.push(text),
        };

        expect(runInstall(["--client", "cursor"], deps)).toBe(1);
        expect(t.err.join("")).toContain("EACCES");
    });

    it("prints JSON and instructions for Cherry Studio and touches no file", () => {
        const t = setup();

        expect(t.run(["--client", "cherry-studio"])).toBe(0);
        expect(t.writes).toEqual([]);
        expect(t.out.join("")).toContain("Import from JSON");
        expect(t.out.join("")).toContain('"command": "npx"');
    });

    it("removes the entry with --remove", () => {
        const t = setup();

        t.run(["--client", "cursor"]);

        expect(t.run(["--client", "cursor", "--remove"])).toBe(0);
        expect(JSON.parse(t.store.get("/home/u/.cursor/mcp.json") ?? "").mcpServers).toEqual({});
    });

    it("rejects an invalid allowed domain with exit code 2 and names the entry", () => {
        const t = setup();

        expect(t.run(["--client", "cursor", "--allowed-domains", "https://example.com"])).toBe(2);
        expect(t.writes).toEqual([]);
        expect(t.err.join("")).toContain('invalid entry "https://example.com"');
        expect(t.err.join("")).toContain("*.example.com");
    });

    it("rejects a bad server flag with exit code 2 and the usage", () => {
        const t = setup();

        expect(t.run(["--client", "cursor", "--mode", "weird"])).toBe(2);
        expect(t.writes).toEqual([]);
        expect(t.err.join("")).toContain("Usage:");
        expect(t.run(["--client", "cursor", "--bogus"])).toBe(2);
        expect(t.run(["--client", "nope"])).toBe(2);
    });
});
