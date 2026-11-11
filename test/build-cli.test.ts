import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("builds a runnable CLI after replacing the output directory", () => {
    const root = process.cwd();
    const dir = mkdtempSync(path.join(os.tmpdir(), "cdm-build-cli-"));
    const windows = process.platform === "win32";

    try {
        for (const entry of ["src", "scripts", "package.json", "tsconfig.json", "tsconfig.build.json"]) {
            cpSync(path.join(root, entry), path.join(dir, entry), { recursive: true });
        }

        symlinkSync(
            path.join(root, "node_modules"), path.join(dir, "node_modules"), windows ? "junction" : "dir",
        );

        for (let attempt = 0; attempt < 2; attempt += 1) {
            const build = spawnSync("npm", ["run", "build"], {
                cwd: dir, shell: windows, encoding: "utf8", timeout: 120_000,
            });

            expect(build.error).toBeUndefined();
            expect(build.status, build.stderr).toBe(0);
        }

        const cli = path.join(dir, "dist", "cli.js");
        const executable = path.join(dir, "chromium-devtools-mcp");

        if (!windows) {
            expect(statSync(cli).mode & 0o111).toBe(0o111);
            symlinkSync(cli, executable);
        }

        const run = spawnSync(windows ? process.execPath : executable, windows ? [cli, "--help"] : ["--help"], {
            cwd: dir, encoding: "utf8", timeout: 30_000,
        });

        expect(run.error).toBeUndefined();
        expect(run.status, run.stderr).toBe(0);
        expect(`${run.stdout}${run.stderr}`).toContain("Usage: chromium-devtools-mcp");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}, 120_000);
