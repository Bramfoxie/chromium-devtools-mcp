import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { findOnPath, runProgram, type RunResult } from "../../util/programs.js";

const REPORT_CAP_BYTES = 64 * 1024 * 1024;

export interface LighthouseTools {
    find(): Promise<string | undefined>;
    chromePath(): string | undefined;
    run(
        program  : string,
        args     : string[],
        cwd      : string,
        timeoutMs: number,
        env      : NodeJS.ProcessEnv,
        signal   : AbortSignal,
    ): Promise<RunResult>;
    read(file: string): Promise<string>;
}

export interface Launch {
    command: string;
    prefix : string[];
}

const exists = async (file: string): Promise<boolean> =>
    access(file).then(() => true, () => false);

// Node cannot start a .cmd file without a shell, so npm's Windows shim is replaced by the script it runs.
export async function resolveLaunch(
    program: string,
    node   : string,
    present: (file: string) => Promise<boolean> = exists,
): Promise<Launch | undefined> {
    if (!/\.cmd$/i.test(program)) return { command: program, prefix: [] };

    const script = path.win32.join(
        path.win32.dirname(program),
        "node_modules",
        "lighthouse",
        "cli",
        "index.js",
    );

    return (await present(script)) ? { command: node, prefix: [script] } : undefined;
}

// Lighthouse is not shipped with this package: it is the program already installed on the machine.
export function nodeLighthouseTools(
    env     : NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
    chrome  : () => string | undefined,
): LighthouseTools {
    return {
        find      : () => findOnPath(env, platform, "lighthouse"),
        chromePath: chrome,
        run       : async (program, args, cwd, timeoutMs, runEnv, signal) => {
            const launch = await resolveLaunch(program, process.execPath);

            if (launch === undefined) {
                return {
                    ok   : false,
                    error: `${program} is a Windows shim that cannot be started directly and its lighthouse script was not found next to it. Reinstall Lighthouse with npm install -g lighthouse.`,
                };
            }

            return runProgram(launch.command, [...launch.prefix, ...args], {
                cwd,
                timeoutMs,
                env: runEnv,
                signal,
            });
        },
        read: async (file) => {
            const buffer = await readFile(file);

            if (buffer.byteLength > REPORT_CAP_BYTES) throw new Error("the report is too large");

            return buffer.toString("utf8");
        },
    };
}
