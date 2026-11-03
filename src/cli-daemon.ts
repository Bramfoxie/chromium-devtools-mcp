import { parseArgs } from "node:util";
import { z } from "zod";
import {
    connectToDaemon,
    currentLayout,
    DaemonError,
    DaemonNotRunningError,
    describeSettings,
    helloIdentity,
    IpcClient,
    IpcClosedError,
} from "./daemon/index.js";
import { daemonLogFile } from "./mcp/server.js";
import { abortableSleep } from "./util/sleep.js";
import { messageOf } from "./util/message-of.js";
import { readIfExistsSync } from "./util/read-if-exists.js";

export const DAEMON_SUBCOMMANDS = ["status", "stop", "logs"] as const;

export type DaemonSubcommand = (typeof DAEMON_SUBCOMMANDS)[number];

const DEFAULT_LOG_LINES = 100;
const MAX_LOG_LINES = 10_000;
const STOP_WAIT_MS = 30_000;
const STOP_POLL_MS = 200;

const statusSchema = z.object({
    state  : z.string(),
    browser: z.string(),
    mode   : z.string(),
    message: z.string().optional(),
});

export interface DaemonControlDeps {
    connect    : () => Promise<IpcClient>;
    logFile    : string;
    readLog    : (file: string) => string | undefined;
    out        : (text: string) => void;
    err        : (text: string) => void;
    sleep      : (ms: number) => Promise<void>;
    now        : () => number;
    stopWaitMs?: number;
}

export function realDaemonControlDeps(): DaemonControlDeps {
    const layout = currentLayout();

    return {
        connect: () => connectToDaemon({ clientName: "cli", layout }),
        logFile: daemonLogFile(layout),
        readLog: readIfExistsSync,
        out    : (text) => void process.stdout.write(text),
        err    : (text) => void process.stderr.write(text),
        sleep  : (ms) => abortableSleep(ms),
        now    : () => Date.now(),
    };
}

function isNotRunning(error: unknown): boolean {
    return error instanceof DaemonNotRunningError || error instanceof IpcClosedError;
}

async function connected(deps: DaemonControlDeps): Promise<IpcClient | undefined> {
    try {
        return await deps.connect();
    } catch (error) {
        if (isNotRunning(error)) return undefined;

        throw error;
    }
}

async function status(deps: DaemonControlDeps): Promise<number> {
    const client = await connected(deps);

    if (!client) {
        deps.out("The daemon is not running.\n");

        return 1;
    }

    try {
        const reply = statusSchema.safeParse(await client.request("daemon.status"));
        const identity = helloIdentity(client);

        if (!reply.success) {
            deps.err("The daemon answered the status request with an unexpected result.\n");

            return 1;
        }

        deps.out(`The daemon is running (${reply.data.state}).\n`);
        deps.out(`Browser: ${reply.data.browser}, mode ${reply.data.mode}\n`);

        if (reply.data.message !== undefined) deps.out(`Message: ${reply.data.message}\n`);
        if (identity !== undefined) deps.out(`Settings: ${describeSettings(identity)}\n`);

        deps.out(`Log: ${deps.logFile}\n`);

        return 0;
    } finally {
        await client.close();
    }
}

async function stillRunning(deps: DaemonControlDeps): Promise<boolean> {
    const client = await connected(deps);

    await client?.close();

    return client !== undefined;
}

async function stop(deps: DaemonControlDeps): Promise<number> {
    const client = await connected(deps);

    if (!client) {
        deps.out("The daemon is not running.\n");

        return 0;
    }

    try {
        await client.request("daemon.stop");
    } catch (error) {
        if (!(error instanceof IpcClosedError)) throw error;
    } finally {
        await client.close();
    }

    const deadline = deps.now() + (deps.stopWaitMs ?? STOP_WAIT_MS);

    while (await stillRunning(deps)) {
        if (deps.now() >= deadline) {
            deps.err(`The daemon did not stop in time. See ${deps.logFile} for its messages.\n`);

            return 1;
        }

        await deps.sleep(STOP_POLL_MS);
    }

    deps.out("The daemon stopped.\n");

    return 0;
}

function parseLines(argv: string[]): number | string {
    let lines: string | undefined;

    try {
        ({ values: { lines } } = parseArgs({
            args            : argv,
            strict          : true,
            allowPositionals: false,
            options         : { lines: { type: "string" } },
        }));
    } catch {
        return "Usage: chromium-devtools-mcp daemon logs [--lines <count>]";
    }

    if (lines === undefined) return DEFAULT_LOG_LINES;

    const count = /^\d+$/.test(lines) ? Number(lines) : 0;

    return count >= 1 && count <= MAX_LOG_LINES
        ? count
        : `--lines must be a whole number from 1 to ${MAX_LOG_LINES}.`;
}

function logs(deps: DaemonControlDeps, argv: string[]): number {
    const lines = parseLines(argv);

    if (typeof lines === "string") {
        deps.err(`${lines}\n`);

        return 2;
    }

    const content = deps.readLog(deps.logFile);

    if (content === undefined) {
        deps.out(`There is no daemon log yet at ${deps.logFile}.\n`);

        return 0;
    }

    const all = content.split(/\r?\n/);

    if (all.at(-1) === "") all.pop();

    deps.out(`${all.slice(-lines).join("\n")}\n`);

    return 0;
}

function onlyOptions(argv: string[]): boolean {
    try {
        parseArgs({ args: argv, strict: true, allowPositionals: false, options: {} });

        return true;
    } catch {
        return false;
    }
}

export async function runDaemonControl(
    subcommand: DaemonSubcommand,
    argv      : string[],
    deps      : DaemonControlDeps,
): Promise<number> {
    try {
        if (subcommand === "logs") return logs(deps, argv);

        if (!onlyOptions(argv)) {
            deps.err(`Usage: chromium-devtools-mcp daemon ${subcommand}\n`);

            return 2;
        }

        return subcommand === "status" ? await status(deps) : await stop(deps);
    } catch (error) {
        deps.err(`${error instanceof DaemonError ? error.message : messageOf(error)}\n`);

        return 1;
    }
}
