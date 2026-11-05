import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function gate(runs: object[]): number | null {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    const script = workflow.split("        run: |\n")[1]?.split("\n\n  publish:")[0];

    if (!script) throw new Error("CI gate script not found");

    const directory = mkdtempSync(join(tmpdir(), "ci-gate-"));

    directories.push(directory);
    writeFileSync(join(directory, "runs.json"), JSON.stringify(runs));
    writeFileSync(join(directory, "gh"), '#!/bin/sh\ncat "$RUNS_FILE"\n', { mode: 0o755 });
    writeFileSync(join(directory, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = spawnSync("bash", ["-c", script], {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RUNS_FILE: join(directory, "runs.json"), GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: "abc" },
    });

    return result.status;
}

const run = (databaseId: number, attempt: number, status: string, conclusion: string | null) => ({
    databaseId,
    attempt,
    status,
    conclusion,
});

describe.skipIf(process.platform === "win32")("release CI gate", () => {
    it("ignores an earlier failure of the same workflow run", () => {
        expect(gate([run(1, 1, "completed", "failure"), run(1, 2, "completed", "success")])).toBe(0);
    });

    it("blocks a current failure even after an earlier success", () => {
        expect(gate([run(1, 1, "completed", "success"), run(1, 2, "completed", "failure")])).toBe(1);
    });

    it("blocks a separate failed run", () => {
        expect(gate([run(1, 2, "completed", "success"), run(2, 1, "completed", "failure")])).toBe(1);
    });

    it("blocks unfinished and missing runs", () => {
        expect(gate([run(1, 1, "in_progress", null)])).toBe(1);
        expect(gate([])).toBe(1);
    }, 20000);
});
