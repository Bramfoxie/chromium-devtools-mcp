import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    rm,
    stat,
    symlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlreadyRunningError, DaemonError, ensurePrivateDir } from "../src/daemon/index.js";
import { acquireInstance, type InstanceIO, type InstanceOptions } from "../src/daemon/lock.js";
import { type DirIO, type DirStat } from "../src/daemon/private-dir.js";
import { generateToken, ensureToken, readToken, tokensMatch } from "../src/daemon/token.js";

const posix = process.platform !== "win32";
const uid = process.getuid?.();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-"));

    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    return dir;
}

function errno(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(code), { code });
}

function fakeIO(listenResults: Array<"ok" | NodeJS.ErrnoException>, probe: "alive" | "stale") {
    const calls: string[] = [];
    const lockResults: boolean[] = [];
    const io: InstanceIO = {
        listen: async () => {
            calls.push("listen");
            const next = listenResults.shift() ?? "ok";

            if (next !== "ok") throw next;

            return {
                close: async () => {
                    calls.push("close");
                },
            };
        },
        probe: async () => {
            calls.push("probe");

            return probe;
        },
        removeSocket: async () => {
            calls.push("remove");
        },
        lockCleanup: async () => {
            calls.push("lock");
            if (lockResults.length > 0 && !lockResults.shift()) return undefined;

            return async () => {
                calls.push("unlock");
            };
        },
        sleep: async () => {
            calls.push("sleep");
        },
    };

    return { io, calls, lockResults };
}

const options = (overrides: Partial<InstanceOptions> = {}): InstanceOptions => ({
    socketPath: "/run/x/daemon.sock",
    runtimeDir: "/run/x",
    platform  : "linux",
    uid       : 1000,
    ...overrides,
});

describe("acquireInstance with a fake socket layer", () => {
    const noDir = { ensureDir: async () => undefined };

    it("listens, prepares the runtime directory and closes the server once on release", async () => {
        const { io, calls } = fakeIO(["ok"], "stale");
        const prepared: string[] = [];
        const handle = await acquireInstance(options(), () => undefined, {
            io,
            ensureDir: async (dir) => void prepared.push(dir),
        });

        expect(prepared).toEqual(["/run/x"]);
        await handle.release();
        await handle.release();
        expect(calls).toEqual(["listen", "close"]);
    });

    it("prepares no directory for a Windows named pipe", async () => {
        const { io } = fakeIO(["ok"], "stale");
        const prepared: string[] = [];

        await acquireInstance(
            options({ platform: "win32", runtimeDir: undefined, socketPath: "\\\\.\\pipe\\x" }),
            () => undefined,
            { io, ensureDir: async (dir) => void prepared.push(dir) },
        );
        expect(prepared).toEqual([]);
    });

    it("reports a running daemon when the socket answers", async () => {
        const { io, calls } = fakeIO([errno("EADDRINUSE"), errno("EADDRINUSE")], "alive");
        const failure = await acquireInstance(options(), () => undefined, { io, ...noDir }).catch(
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(AlreadyRunningError);
        expect((failure as AlreadyRunningError).socketPath).toBe("/run/x/daemon.sock");
        expect(calls).toEqual(["listen", "lock", "listen", "probe", "unlock"]);
    });

    it("replaces a stale socket under the start lock", async () => {
        const { io, calls } = fakeIO([errno("EADDRINUSE"), errno("EADDRINUSE"), "ok"], "stale");

        await acquireInstance(options(), () => undefined, { io, ...noDir });
        expect(calls).toEqual(["listen", "lock", "listen", "probe", "remove", "listen", "unlock"]);
    });

    it("uses a daemon that started while waiting for the lock instead of replacing it", async () => {
        const { io, calls } = fakeIO([errno("EADDRINUSE"), "ok"], "stale");

        await acquireInstance(options(), () => undefined, { io, ...noDir });
        expect(calls).toEqual(["listen", "lock", "listen", "unlock"]);
    });

    it("reports a running daemon when another process binds right after cleanup", async () => {
        const { io, calls } = fakeIO(
            [errno("EADDRINUSE"), errno("EADDRINUSE"), errno("EADDRINUSE")],
            "stale",
        );

        await expect(
            acquireInstance(options(), () => undefined, { io, ...noDir }),
        ).rejects.toBeInstanceOf(AlreadyRunningError);
        expect(calls.at(-1)).toBe("unlock");
    });

    it("waits while another starter holds the start lock", async () => {
        const { io, calls, lockResults } = fakeIO(
            [errno("EADDRINUSE"), errno("EADDRINUSE"), "ok"],
            "stale",
        );

        lockResults.push(false, false);
        await acquireInstance(options(), () => undefined, { io, ...noDir });
        expect(calls.filter((call) => call === "sleep")).toHaveLength(2);
        expect(calls.filter((call) => call === "lock")).toHaveLength(3);
    });

    it("gives up with DaemonError when the start lock never frees", async () => {
        const { io, lockResults } = fakeIO([errno("EADDRINUSE")], "stale");

        lockResults.push(...Array.from({ length: 100 }, () => false));
        const failure = await acquireInstance(options(), () => undefined, { io, ...noDir }).catch(
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(DaemonError);
        expect(failure).not.toBeInstanceOf(AlreadyRunningError);
    });

    it("treats an address in use on Windows as a running daemon without locking or probing", async () => {
        const { io, calls } = fakeIO([errno("EADDRINUSE")], "stale");

        await expect(
            acquireInstance(options({ platform: "win32", runtimeDir: undefined }), () => undefined, {
                io,
                ...noDir,
            }),
        ).rejects.toBeInstanceOf(AlreadyRunningError);
        expect(calls).toEqual(["listen"]);
    });

    it("wraps other listen errors in DaemonError without leaking the path twice", async () => {
        const { io } = fakeIO([errno("EACCES")], "stale");
        const failure = await acquireInstance(options(), () => undefined, { io, ...noDir }).catch(
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(DaemonError);
        expect(failure).not.toBeInstanceOf(AlreadyRunningError);
        expect((failure as Error).message).toBe("Cannot listen on the daemon socket: EACCES.");
    });

    it("passes the restrict flag only on Unix platforms", async () => {
        const flags: boolean[] = [];
        const io: InstanceIO = {
            ...fakeIO(["ok"], "stale").io,
            listen: async (_path, _handler, restrict) => {
                flags.push(restrict);

                return { close: async () => undefined };
            },
        };

        await acquireInstance(options(), () => undefined, { io, ...noDir });
        await acquireInstance(options({ platform: "win32", runtimeDir: undefined }), () => undefined, {
            io,
            ...noDir,
        });
        expect(flags).toEqual([true, false]);
    });

    it.each([
        ["darwin", 103, 104],
        ["linux", 107, 108],
    ] as const)(
        "enforces the %s socket path limit at the exact boundary",
        async (platform, ok, tooLong) => {
            const make = (bytes: number) => `/${"a".repeat(bytes - 1)}`;
            const { io } = fakeIO(["ok", "ok"], "stale");
            const deps = { io, ...noDir };

            await expect(
                acquireInstance(
                    options({ platform, socketPath: make(ok), runtimeDir: undefined }),
                    () => undefined,
                    deps,
                ),
            ).resolves.toBeDefined();
            await expect(
                acquireInstance(
                    options({ platform, socketPath: make(tooLong), runtimeDir: undefined }),
                    () => undefined,
                    deps,
                ),
            ).rejects.toThrow(/too long/);
        },
    );

    it("measures the socket path in bytes, not characters", async () => {
        const { io, calls } = fakeIO(["ok"], "stale");
        const cyrillic = `/${"\u0436".repeat(60)}`;

        await expect(
            acquireInstance(
                options({ platform: "darwin", socketPath: cyrillic, runtimeDir: undefined }),
                () => undefined,
                { io, ...noDir },
            ),
        ).rejects.toThrow(/too long/);
        expect(calls).toEqual([]);
    });
});

describe("ensurePrivateDir with a fake file system", () => {
    function dirIO(stat: Partial<DirStat>) {
        const calls: string[] = [];
        const io: DirIO = {
            mkdir: async () => void calls.push("mkdir"),
            lstat: async () => ({
                uid           : 1000,
                mode          : 0o40700,
                isDirectory   : true,
                isSymbolicLink: false,
                ...stat,
            }),
            chmod: async (_dir, mode) => void calls.push(`chmod ${mode.toString(8)}`),
        };

        return { io, calls };
    }

    it("leaves a private directory alone", async () => {
        const { io, calls } = dirIO({});

        await ensurePrivateDir("/d", "linux", 1000, io);
        expect(calls).toEqual(["mkdir"]);
    });

    it("tightens a directory that others can read", async () => {
        const { io, calls } = dirIO({ mode: 0o40755 });

        await ensurePrivateDir("/d", "linux", 1000, io);
        expect(calls).toEqual(["mkdir", "chmod 700"]);
    });

    it("tightens a directory that only the group can access", async () => {
        const { io, calls } = dirIO({ mode: 0o40750 });

        await ensurePrivateDir("/d", "linux", 1000, io);
        expect(calls).toEqual(["mkdir", "chmod 700"]);
    });

    it("refuses a directory owned by another user", async () => {
        const { io } = dirIO({ uid: 0 });

        await expect(ensurePrivateDir("/d", "linux", 1000, io)).rejects.toThrow(
            /owned by another user/,
        );
    });

    it("refuses a symbolic link and a non-directory", async () => {
        await expect(
            ensurePrivateDir("/d", "linux", 1000, dirIO({ isSymbolicLink: true }).io),
        ).rejects.toThrow(/real directory/);
        await expect(
            ensurePrivateDir("/d", "linux", 1000, dirIO({ isDirectory: false }).io),
        ).rejects.toThrow(/real directory/);
    });

    it("skips ownership checks when the uid is unknown", async () => {
        const { io } = dirIO({ uid: 0 });

        await expect(ensurePrivateDir("/d", "linux", undefined, io)).resolves.toBeUndefined();
    });

    it("only creates the directory on Windows", async () => {
        const { io, calls } = dirIO({ uid: 0, mode: 0o40777 });

        await ensurePrivateDir("C:\\d", "win32", undefined, io);
        expect(calls).toEqual(["mkdir"]);
    });
});

describe.skipIf(!posix)("ensurePrivateDir on the real file system", () => {
    it("creates a directory with mode 0700 and tightens an existing one", async () => {
        const base = await tempDir();
        const created = path.join(base, "new");

        await ensurePrivateDir(created, process.platform, uid);
        expect((await stat(created)).mode & 0o777).toBe(0o700);
        const loose = path.join(base, "loose");

        await mkdir(loose, { mode: 0o755 });
        await chmod(loose, 0o755);
        await ensurePrivateDir(loose, process.platform, uid);
        expect((await stat(loose)).mode & 0o777).toBe(0o700);
    });
});

describe("token", () => {
    it("generates 64 hex characters and never repeats", () => {
        const a = generateToken();

        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(generateToken()).not.toBe(a);
    });

    it("creates a token once and returns the same one afterwards", async () => {
        const dir = await tempDir();
        const file = path.join(dir, "state", "daemon.token");
        const first = await ensureToken(file, process.platform, uid);

        expect(await readToken(file)).toBe(first);
        expect(await ensureToken(file, process.platform, uid)).toBe(first);
        expect(await readdir(path.dirname(file))).toEqual(["daemon.token"]);
    });

    it("gives parallel callers the same token", async () => {
        const dir = await tempDir();
        const file = path.join(dir, "daemon.token");
        const tokens = await Promise.all(
            Array.from({ length: 8 }, () => ensureToken(file, process.platform, uid)),
        );

        expect(new Set(tokens).size).toBe(1);
        expect(await readToken(file)).toBe(tokens[0]);
        expect(await readdir(dir)).toEqual(["daemon.token"]);
    });

    it("replaces a corrupted token file", async () => {
        const dir = await tempDir();
        const file = path.join(dir, "daemon.token");

        await writeFile(file, "garbage");
        const token = await ensureToken(file, process.platform, uid);

        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(await readToken(file)).toBe(token);
        expect(await readdir(dir)).toEqual(["daemon.token"]);
    });

    it("gives up on a stuck token lock instead of waiting forever", async () => {
        const dir = await tempDir();
        const file = path.join(dir, "daemon.token");

        await writeFile(file, "garbage");
        await mkdir(`${file}.lock`);
        await expect(
            ensureToken(file, process.platform, uid, { lockWaitMs: 50 }),
        ).rejects.toThrow(/token lock .*daemon\.token\.lock.*remove that directory/);
        expect((await readdir(dir)).sort()).toEqual(["daemon.token", "daemon.token.lock"]);
    });

    it("takes over a token lock that is older than the stale limit", async () => {
        const dir = await tempDir();
        const file = path.join(dir, "daemon.token");

        await writeFile(file, "garbage");
        await mkdir(`${file}.lock`);
        const token = await ensureToken(file, process.platform, uid, {
            lockWaitMs: 50,
            now       : () => Date.now() + 60_000,
        });

        expect(await readToken(file)).toBe(token);
        expect(await readdir(dir)).toEqual(["daemon.token"]);
    });

    it("gives parallel callers the persisted token on a corrupted file", async () => {
        const dir = await tempDir();
        const file = path.join(dir, "daemon.token");

        await writeFile(file, "garbage");
        const tokens = await Promise.all(
            Array.from({ length: 8 }, () => ensureToken(file, process.platform, uid)),
        );

        expect(new Set(tokens).size).toBe(1);
        expect(await readToken(file)).toBe(tokens[0]);
        expect(await readdir(dir)).toEqual(["daemon.token"]);
    });

    it.skipIf(!posix)("writes the file with mode 0600", async () => {
        const dir = await tempDir();
        const file = path.join(dir, "daemon.token");

        await ensureToken(file, process.platform, uid);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
    });

    it("fails without leaving files behind when the token path is a directory", async () => {
        const dir = await tempDir();
        const file = path.join(dir, "daemon.token");

        await mkdir(file);
        await expect(ensureToken(file, process.platform, uid)).rejects.toThrow();
        expect(await readdir(dir)).toEqual(["daemon.token"]);
    });

    it.each([
        ["too short", "a".repeat(63)],
        ["too long", "a".repeat(65)],
        ["upper case", "A".repeat(64)],
        ["non hex", "g".repeat(64)],
    ])("rejects a token file that is %s", async (_name, content) => {
        const dir = await tempDir();
        const file = path.join(dir, "daemon.token");

        await writeFile(file, content);
        expect(await readToken(file)).toBeUndefined();
    });

    it("accepts surrounding whitespace in the token file", async () => {
        const dir = await tempDir();
        const file = path.join(dir, "daemon.token");
        const token = generateToken();

        await writeFile(file, `${token}\n`);
        expect(await readToken(file)).toBe(token);
    });

    it("returns undefined for a missing token file and rethrows other read errors", async () => {
        const dir = await tempDir();

        expect(await readToken(path.join(dir, "missing"))).toBeUndefined();
        await expect(readToken(dir)).rejects.toThrow();
    });

    it("compares tokens by value and length", () => {
        const a = generateToken();

        expect(tokensMatch(a, a)).toBe(true);
        expect(tokensMatch(a, generateToken())).toBe(false);
        expect(tokensMatch(a, a.slice(1))).toBe(false);
        expect(tokensMatch(a, "")).toBe(false);
    });
});

async function realOptions(): Promise<InstanceOptions> {
    if (process.platform === "win32") {
        const name = `\\\\.\\pipe\\cdm-test-${randomBytes(6).toString("hex")}`;

        return { socketPath: name, runtimeDir: undefined, platform: "win32", uid: undefined };
    }

    const dir = path.join(await tempDir(), "run");

    return {
        socketPath: path.join(dir, "daemon.sock"),
        runtimeDir: dir,
        platform  : process.platform,
        uid,
    };
}

function connectTo(socketPath: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(socketPath);

        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
        cleanups.push(async () => void socket.destroy());
    });
}

async function killedChildSocket(socketPath: string): Promise<void> {
    const child = spawn(
        process.execPath,
        [
            "-e",
            "require('net').createServer().listen(process.argv[1], () => console.log('ready'))",
            socketPath,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
    );

    await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", () => resolve());
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

    child.kill("SIGKILL");
    await exited;
}

describe("acquireInstance with real sockets", () => {
    it("accepts connections and refuses a second instance", async () => {
        const opts = await realOptions();
        const accepted = new Promise<net.Socket>((resolve) => {
            acquireInstance(opts, resolve).then((handle) => cleanups.push(() => handle.release()));
        });

        await vi.waitFor(async () => {
            await connectTo(opts.socketPath);
        });
        expect(await accepted).toBeInstanceOf(net.Socket);
        await expect(acquireInstance(opts, () => undefined)).rejects.toBeInstanceOf(
            AlreadyRunningError,
        );
    });

    it("survives errors on accepted sockets", async () => {
        const opts = await realOptions();
        const accepted = new Promise<net.Socket>((resolve) => {
            acquireInstance(opts, resolve).then((handle) => cleanups.push(() => handle.release()));
        });

        await vi.waitFor(async () => {
            await connectTo(opts.socketPath);
        });
        const socket = await accepted;

        expect(() => socket.emit("error", new Error("ECONNRESET"))).not.toThrow();
    });

    it("frees the socket on release, drops open clients and allows a new instance", async () => {
        const opts = await realOptions();
        const first = await acquireInstance(opts, () => undefined);
        const client = await connectTo(opts.socketPath);
        const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));

        await first.release();
        await first.release();
        await closed;
        if (posix) expect(existsSync(opts.socketPath)).toBe(false);

        const second = await acquireInstance(opts, () => undefined);

        await second.release();
    });

    it("does not delete the socket of a newer daemon when an old handle is released late", async () => {
        const opts = await realOptions();
        const first = await acquireInstance(opts, () => undefined);

        await first.release();
        const second = await acquireInstance(opts, () => undefined);

        cleanups.push(() => second.release());
        await first.release();
        await connectTo(opts.socketPath);
    });

    it.skipIf(!posix)("takes over a socket file left behind by a killed process", async () => {
        const opts = await realOptions();

        await ensurePrivateDir(opts.runtimeDir ?? "", opts.platform, uid);
        await killedChildSocket(opts.socketPath);
        expect(existsSync(opts.socketPath)).toBe(true);
        const handle = await acquireInstance(opts, () => undefined);

        cleanups.push(() => handle.release());
        await connectTo(opts.socketPath);
    });

    it.skipIf(!posix)(
        "lets exactly one of several parallel starters take over a stale socket",
        async () => {
            const opts = await realOptions();

            await ensurePrivateDir(opts.runtimeDir ?? "", opts.platform, uid);
            await killedChildSocket(opts.socketPath);
            const results = await Promise.allSettled(
                Array.from({ length: 6 }, () => acquireInstance(opts, () => undefined)),
            );
            const winners = results.filter((result) => result.status === "fulfilled");

            for (const winner of winners) {
                cleanups.push(() => winner.value.release());
            }

            expect(winners).toHaveLength(1);

            for (const result of results) {
                if (result.status === "rejected") expect(result.reason).toBeInstanceOf(AlreadyRunningError);
            }

            expect(existsSync(`${opts.socketPath}.lock`)).toBe(false);
            await connectTo(opts.socketPath);
        },
    );

    it.skipIf(!posix)("recovers from a start lock left behind by a crashed starter", async () => {
        const opts = await realOptions();

        await ensurePrivateDir(opts.runtimeDir ?? "", opts.platform, uid);
        await killedChildSocket(opts.socketPath);
        const lock = `${opts.socketPath}.lock`;

        await mkdir(lock);
        const old = new Date(Date.now() - 60_000);

        await utimes(lock, old, old);
        const handle = await acquireInstance(opts, () => undefined);

        cleanups.push(() => handle.release());
        await connectTo(opts.socketPath);
    });

    it.skipIf(!posix)("creates the runtime directory and the socket as private", async () => {
        const opts = await realOptions();
        const handle = await acquireInstance(opts, () => undefined);

        cleanups.push(() => handle.release());
        expect((await stat(opts.runtimeDir ?? "")).mode & 0o777).toBe(0o700);
        expect((await stat(opts.socketPath)).mode & 0o077).toBe(0);
    });

    it.skipIf(!posix)("refuses a runtime directory that is a symbolic link", async () => {
        const opts = await realOptions();
        const target = await tempDir();

        await mkdir(path.dirname(opts.runtimeDir ?? ""), { recursive: true });
        await symlink(target, opts.runtimeDir ?? "");
        await expect(acquireInstance(opts, () => undefined)).rejects.toThrow(/real directory/);
    });
});
