import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const windows = process.platform === "win32";
const root = process.cwd();
const work = mkdtempSync(join(tmpdir(), "cdm-pack-smoke-"));

function npm(args, cwd) {
    const executable = windows ? process.execPath : "npm";
    const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const commandArgs = windows ? [npmCli, ...args] : args;

    return execFileSync(executable, commandArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

try {
    const packDir = join(work, "pack");
    const project = join(work, "project");

    mkdirSync(packDir);
    mkdirSync(project);
    npm(["pack", "--ignore-scripts", "--pack-destination", packDir], root);

    const tarball = readdirSync(packDir).find((name) => name.endsWith(".tgz"));

    if (!tarball) throw new Error("npm pack produced no tarball");

    npm(["init", "-y"], project);
    npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", join(packDir, tarball)], project);

    const bin = join(project, "node_modules", ".bin", windows ? "chromium-devtools-mcp.cmd" : "chromium-devtools-mcp");
    const run = windows
        ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/v:off", "/s", "/c", '""%CDM_PACK_SMOKE_BIN%" --help"'], {
            encoding: "utf8", windowsVerbatimArguments: true, env: { ...process.env, CDM_PACK_SMOKE_BIN: bin },
        })
        : spawnSync(bin, ["--help"], { encoding: "utf8" });
    const help = `${run.stdout}${run.stderr}`;

    if (run.error || run.status !== 0 || !help.includes("Usage: chromium-devtools-mcp")) {
        throw new Error(`Installed package --help failed (status ${run.status}, error ${run.error?.message ?? "none"}):\n${help}`);
    }

    console.error(`pack smoke test passed (${tarball})`);
} finally {
    rmSync(work, { recursive: true, force: true });
}
