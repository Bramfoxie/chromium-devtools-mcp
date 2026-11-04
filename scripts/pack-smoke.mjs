import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shell = process.platform === "win32";
const root = process.cwd();
const work = mkdtempSync(join(tmpdir(), "cdm-pack-smoke-"));

function npm(args, cwd) {
    return execFileSync("npm", args, { cwd, shell, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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

    const bin = join(project, "node_modules", ".bin", "chromium-devtools-mcp");
    const run = spawnSync(bin, ["--help"], { shell, encoding: "utf8" });
    const help = `${run.stdout}${run.stderr}`;

    if (!help.includes("Usage: chromium-devtools-mcp")) {
        throw new Error(`Unexpected --help output from the installed package:\n${help}`);
    }

    console.error(`pack smoke test passed (${tarball})`);
} finally {
    rmSync(work, { recursive: true, force: true });
}
