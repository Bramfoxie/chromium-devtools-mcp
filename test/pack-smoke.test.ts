import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32").each([0, 7])("checks the installed CLI exit status %i with special characters in temporary paths", (exitCode) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cdm pack & smoke ! %CDM_TEST_MARKER% "));
    const bin = path.join(dir, "bin");
    const fake = path.join(dir, "fake npm.cjs");
    const script = path.join(process.cwd(), "scripts", "pack-smoke.mjs");

    try {
        mkdirSync(bin);
        writeFileSync(fake, `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "pack") {
  const dest = args[args.indexOf("--pack-destination") + 1];
  if (!dest || !fs.existsSync(dest)) process.exit(10);
  fs.writeFileSync(path.join(dest, "package.tgz"), "test");
} else if (args[0] === "install") {
  if (!fs.existsSync(args.at(-1))) process.exit(11);
  const bin = path.join(process.cwd(), "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "chromium-devtools-mcp.cmd"), "@echo Usage: chromium-devtools-mcp\\r\\nexit /b " + process.env.CDM_TEST_EXIT + "\\r\\n");
}
`);
        writeFileSync(path.join(bin, "npm.cmd"), '@echo off\r\n"%CDM_TEST_NODE%" "%CDM_TEST_NPM%" %*\r\n');
        const env = { ...process.env };

        for (const key of Object.keys(env)) {
            if (key.toLowerCase() === "npm_execpath") delete env[key];
        }

        const result = spawnSync(process.execPath, [script], {
            cwd     : process.cwd(),
            encoding: "utf8",
            timeout : 30_000,
            env     : {
                ...env,
                PATH           : `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
                TEMP           : dir,
                TMP            : dir,
                npm_execpath   : fake,
                CDM_TEST_EXIT  : String(exitCode),
                CDM_TEST_MARKER: "expanded",
                CDM_TEST_NODE  : process.execPath,
                CDM_TEST_NPM   : fake,
            },
        });

        expect(result.error).toBeUndefined();

        if (exitCode === 0) {
            expect(result.status, result.stderr).toBe(0);
            expect(result.stderr).toContain("pack smoke test passed");
        } else {
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain(`status ${exitCode}`);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
}, 40_000);
