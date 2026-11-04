import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { pathFor } from "../config/index.js";

const STDERR_TAIL_CHARS = 600;

const STOP_GRACE_MS = 2000;

const KEPT_VARIABLES = new Set([
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "DISPLAY",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "ALL_PROXY",
    "SSL_CERT_FILE",
    "PATHEXT",
    "COMSPEC",
    "WINDIR",
    "PROGRAMFILES",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "USER",
    "LOGNAME",
]);

export interface RunResult {
    ok   : boolean;
    error: string;
}

export interface RunOptions {
    cwd      : string;
    timeoutMs: number;
    env?     : NodeJS.ProcessEnv;
    signal?  : AbortSignal;
}

async function executable(file: string): Promise<boolean> {
    try {
        const info = await stat(file);

        if (!info.isFile()) return false;

        await access(file, 1);

        return true;
    } catch {
        return false;
    }
}

export async function findOnPath(
    env     : NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
    name    : string,
): Promise<string | undefined> {
    const p = pathFor(platform);
    const names = platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
    const dirs = (env.PATH ?? env.Path ?? "").split(p.delimiter).filter((dir) => dir !== "");

    for (const dir of dirs) {
        if (!p.isAbsolute(dir)) continue;

        for (const candidate of names) {
            const file = p.join(dir, candidate);

            if (await executable(file)) return file;
        }
    }

    return undefined;
}

// A child gets the variables a program needs to run, not every secret of the server.
export function childEnvironment(
    env  : NodeJS.ProcessEnv,
    extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
    const kept: NodeJS.ProcessEnv = {};

    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined && KEPT_VARIABLES.has(name.toUpperCase())) kept[name] = value;
    }

    for (const [name, value] of Object.entries(extra)) {
        if (value !== undefined) kept[name] = value;
    }

    return kept;
}

function signalGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;

    try {
        if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
                shell      : false,
                stdio      : "ignore",
                windowsHide: true,
            }).on("error", () => undefined);
        } else {
            process.kill(-child.pid, signal);
        }
    } catch {
        child.kill(signal);
    }
}

// Runs a program without a shell, in its own process group, and stops the whole group on a timeout.
export function runProgram(
    program: string,
    args   : string[],
    options: RunOptions,
): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
        let tail = "";
        let settled = false;
        let stopping: string | undefined;
        const child = spawn(program, args, {
            cwd        : options.cwd,
            env        : options.env,
            shell      : false,
            detached   : process.platform !== "win32",
            stdio      : ["ignore", "ignore", "pipe"],
            windowsHide: true,
        });
        const finish = (result: RunResult): void => {
            if (settled) return;

            settled = true;
            clearTimeout(timer);
            clearTimeout(killer);
            options.signal?.removeEventListener("abort", onAbort);
            resolve(result);
        };
        let killer: NodeJS.Timeout | undefined;
        const stop = (reason: string): void => {
            if (stopping !== undefined || settled) return;

            stopping = reason;
            signalGroup(child, "SIGINT");
            killer = setTimeout(() => {
                signalGroup(child, "SIGKILL");
                finish({ ok: false, error: reason });
            }, STOP_GRACE_MS);
        };
        const onAbort = (): void => stop("the call was cancelled");
        const timer = setTimeout(
            () => stop(`${path.basename(program)} did not finish within ${options.timeoutMs} ms`),
            options.timeoutMs,
        );

        options.signal?.addEventListener("abort", onAbort, { once: true });
        child.stderr.on("data", (chunk: Buffer) => {
            tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
        });
        child.once("error", (error) => finish({ ok: false, error: error.message }));
        child.once("close", (code) => {
            if (stopping !== undefined) signalGroup(child, "SIGKILL");

            finish({
                ok   : code === 0 && stopping === undefined,
                error: stopping ?? (tail.trim() || `${path.basename(program)} exited with code ${code}`),
            });
        });
    });
}
