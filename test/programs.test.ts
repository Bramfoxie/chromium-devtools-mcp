import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLaunch } from "../src/tools/perf/lighthouse-tools.js";
import { childEnvironment, findOnPath, runProgram } from "../src/util/programs.js";

const dirs: string[] = [];

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-programs-"));

    dirs.push(dir);

    return dir;
}

describe("childEnvironment", () => {
    it("keeps the variables a program needs and drops the rest", () => {
        const env = childEnvironment({
            PATH                       : "/bin",
            HOME                       : "/home/a",
            CHROMIUM_DEVTOOLS_MCP_TOKEN: "secret",
            AWS_SECRET_ACCESS_KEY      : "secret",
        });

        expect(env).toEqual({ PATH: "/bin", HOME: "/home/a" });
    });

    it("adds extra variables and skips undefined ones", () => {
        expect(childEnvironment({ PATH: "/bin" }, { CHROME_PATH: "/c", GONE: undefined })).toEqual({
            PATH       : "/bin",
            CHROME_PATH: "/c",
        });
    });
});

describe("findOnPath", () => {
    it("finds an executable file and skips relative directories", async () => {
        const dir = await scratch();
        const file = path.join(dir, "tool");

        await writeFile(file, "#!/bin/sh\n");
        await chmod(file, 0o755);

        expect(await findOnPath({ PATH: `relative${path.delimiter}${dir}` }, process.platform, "tool")).toBe(file);
        expect(await findOnPath({ PATH: "relative" }, process.platform, "tool")).toBeUndefined();
        expect(await findOnPath({}, process.platform, "tool")).toBeUndefined();
    });
});

describe.skipIf(process.platform === "win32")("runProgram", () => {
    it("reports success and a failure with the tail of stderr", async () => {
        const dir = await scratch();
        const ok = await runProgram("/bin/sh", ["-c", "exit 0"], { cwd: dir, timeoutMs: 5000 });
        const bad = await runProgram("/bin/sh", ["-c", "echo broken >&2; exit 3"], { cwd: dir, timeoutMs: 5000 });

        expect(ok.ok).toBe(true);
        expect(bad.ok).toBe(false);
        expect(bad.error).toContain("broken");
    });

    it("stops a program that runs past the timeout", async () => {
        const dir = await scratch();
        const result = await runProgram("/bin/sh", ["-c", "sleep 30"], { cwd: dir, timeoutMs: 200 });

        expect(result.ok).toBe(false);
    });

    it("stops a program when the signal aborts", async () => {
        const dir = await scratch();
        const controller = new AbortController();
        const pending = runProgram("/bin/sh", ["-c", "sleep 30"], {
            cwd      : dir,
            timeoutMs: 20_000,
            signal   : controller.signal,
        });

        setTimeout(() => controller.abort(), 100);

        expect((await pending).ok).toBe(false);
    });

    it("passes only the given environment", async () => {
        const dir = await scratch();
        const result = await runProgram("/bin/sh", ["-c", 'test -z "$LEAK"'], {
            cwd      : dir,
            timeoutMs: 5000,
            env      : { PATH: "/usr/bin:/bin" },
        });

        expect(result.ok).toBe(true);
    });
});

describe("resolveLaunch", () => {
    it("leaves a normal program alone", async () => {
        expect(await resolveLaunch("/usr/bin/lighthouse", "node")).toEqual({
            command: "/usr/bin/lighthouse",
            prefix : [],
        });
    });

    it("replaces a Windows shim with node and the script next to it", async () => {
        const seen: string[] = [];
        const launch = await resolveLaunch("C:\\npm\\lighthouse.cmd", "C:\\node.exe", async (file) => {
            seen.push(file);

            return true;
        });

        expect(launch).toEqual({
            command: "C:\\node.exe",
            prefix : ["C:\\npm\\node_modules\\lighthouse\\cli\\index.js"],
        });
        expect(seen).toEqual(launch?.prefix);
    });

    it("gives up when the script is missing", async () => {
        expect(await resolveLaunch("C:\\npm\\lighthouse.cmd", "node", async () => false)).toBeUndefined();
    });
});
