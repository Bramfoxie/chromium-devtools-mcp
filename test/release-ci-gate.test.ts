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

function gate(runs: object[], gh = 'cat "$RUNS_FILE"', jq?: string): { status: number | null; output: string } {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    const script = workflow.split("        run: |\n")[1]?.split("\n\n  publish:")[0];

    if (!script) throw new Error("CI gate script not found");

    const directory = mkdtempSync(join(tmpdir(), "ci-gate-"));

    directories.push(directory);
    writeFileSync(join(directory, "runs.json"), JSON.stringify(runs));
    writeFileSync(join(directory, "gh"), `#!/bin/sh\n${gh}\n`, { mode: 0o755 });
    if (jq !== undefined) writeFileSync(join(directory, "jq"), `#!/bin/sh\n${jq}\n`, { mode: 0o755 });

    writeFileSync(join(directory, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = spawnSync("bash", ["-c", script], {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RUNS_FILE: join(directory, "runs.json"), GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: "abc" },
    });

    return { status: result.status, output: result.stdout.toString() };
}

const run = (databaseId: number, attempt: number, status: string, conclusion: string | null) => ({
    databaseId,
    attempt,
    status,
    conclusion,
});

describe.skipIf(process.platform === "win32")("release CI gate", () => {
    it("ignores an earlier failure of the same workflow run", () => {
        expect(gate([run(1, 1, "completed", "failure"), run(1, 2, "completed", "success")]).status).toBe(0);
    });

    it("blocks a current failure even after an earlier success", () => {
        expect(gate([run(1, 1, "completed", "success"), run(1, 2, "completed", "failure")]).status).toBe(1);
    });

    it("blocks runs without an attempt or database ID", () => {
        const result = gate([{ status: "completed", conclusion: "success" }]);

        expect(result.status).toBe(1);
        expect(result.output).toContain("did not finish");
        expect(result.output).not.toContain("CI passed");
    }, 20000);

    it("blocks a reply that is not a list of runs", () => {
        const result = gate([], 'echo "{}"');

        expect(result.status).toBe(1);
        expect(result.output).toContain("did not finish");
    }, 20000);

    it("blocks errors from gh and jq", () => {
        expect(gate([], "exit 1").output).toContain("did not finish");
        expect(gate([], undefined, "exit 1").output).toContain("did not finish");
    }, 20000);

    it("blocks a separate failed run", () => {
        const result = gate([run(1, 2, "completed", "success"), run(2, 1, "completed", "failure")]);

        expect(result.status).toBe(1);
        expect(result.output).toContain("CI did not pass");
    });

    it("blocks unfinished and missing runs", () => {
        expect(gate([run(1, 1, "in_progress", null)]).output).toContain("did not finish");
        expect(gate([]).output).toContain("did not finish");
    }, 20000);

    it("blocks a commit with too many runs to verify immediately", () => {
        const runs = Array.from({ length: 1000 }, (_, index) => run(index + 1, 1, "completed", "success"));
        const result = gate(runs);

        expect(result.status).toBe(1);
        expect(result.output).toContain("Too many CI runs");
    });
});
