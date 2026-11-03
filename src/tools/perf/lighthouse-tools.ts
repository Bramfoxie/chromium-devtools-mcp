import { readFile } from "node:fs/promises";
import { findOnPath, runProgram, type RunResult } from "./video.js";

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

// Lighthouse is not shipped with this package: it is the program already installed on the machine.
export function nodeLighthouseTools(
    env     : NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
    chrome  : () => string | undefined,
): LighthouseTools {
    return {
        find      : () => findOnPath(env, platform, "lighthouse"),
        chromePath: chrome,
        run       : (program, args, cwd, timeoutMs, runEnv, signal) =>
            runProgram(program, args, { cwd, timeoutMs, env: runEnv, signal }),
        read: async (file) => {
            const buffer = await readFile(file);

            if (buffer.byteLength > REPORT_CAP_BYTES) throw new Error("the report is too large");

            return buffer.toString("utf8");
        },
    };
}
