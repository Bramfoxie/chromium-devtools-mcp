import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonConfigMismatchError, DaemonError, type DaemonIdentity, DaemonNotRunningError, ErrorCode, type IpcClient, IpcClosedError, IpcTimeoutError, RpcError } from "../src/daemon/index.js";
import {
    DaemonLink,
    DaemonNotReadyError,
    type LinkDeps,
    type StartedDaemon,
} from "../src/mcp/index.js";

afterEach(() => {
    vi.restoreAllMocks();
});

type Handler = (method: string, params: unknown) => unknown | Promise<unknown>;

class FakeIpc {
    closed = false;
    calls  : Array<{ method: string; params: unknown; options?: { timeoutMs?: number } }> = [];
    closes = 0;
    failure: string | undefined;

    constructor(private readonly handler: Handler = () => ({})) {}

    async request(
        method  : string,
        params? : unknown,
        options?: { timeoutMs?: number },
    ): Promise<unknown> {
        if (this.closed) throw new IpcClosedError("closed");

        this.calls.push({ method, params, options });

        return this.handler(method, params);
    }

    async close(): Promise<void> {
        this.closes += 1;
        this.closed = true;
    }

    drop(): void {
        this.closed = true;
    }
}

const identity: DaemonIdentity = { browser: "chrome", mode: "managed", debugPort: 9222, allowFocus: false };
const asIpc = (fake: FakeIpc) => fake as unknown as IpcClient;
const alive: StartedDaemon = { exited: new Promise<void>(() => undefined) };

function fakeClock() {
    const clock = { time: 0 };

    return {
        clock,
        now  : () => clock.time,
        sleep: async (ms: number) => {
            clock.time += ms;
        },
    };
}

function link(overrides: Partial<LinkDeps> = {}, isolated?: boolean) {
    const starts: number[] = [];
    const connects: Array<{ browser: string; mode: string }> = [];
    const deps: LinkDeps = {
        connect: async (expect) => {
            connects.push(expect);

            throw new DaemonNotRunningError();
        },
        startDaemon: async () => {
            starts.push(Date.now());

            return alive;
        },
        sleep         : async () => undefined,
        now           : () => Date.now(),
        logFile       : "/data/daemon.log",
        startTimeoutMs: 2000,
        pollIntervalMs: 1,
        ...overrides,
    };

    return {
        link: new DaemonLink({ identity, isolated }, deps),
        starts,
        connects,
    };
}

describe("a daemon that fails to start the browser", () => {
    it("reports the reason it sent before closing", async () => {
        const ipc = new FakeIpc((method) => {
            if (method === "daemon.status") {
                ipc.failure = "Chrome did not expose remote debugging within 45000 ms.";
                ipc.drop();

                throw new IpcClosedError("the daemon closed the connection");
            }

            throw new RpcError(ErrorCode.browserNotReady, "not ready");
        });
        const { link: l } = link({ connect: async () => asIpc(ipc) });
        const failure = await l.request("x").catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(DaemonError);
        const message = (failure as Error).message;

        expect(message).toContain(
            "The browser could not be started: Chrome did not expose remote debugging within 45000 ms.",
        );
        expect(message).toContain("browser installation");
        expect(message).toContain("profile");
        expect(message).toContain("/data/daemon.log");
    });

    it("starts a fresh daemon on the next call after a failed start", async () => {
        const failed = new FakeIpc(() => {
            failed.failure = "browser refused";
            failed.drop();

            throw new IpcClosedError("gone");
        });
        const working = new FakeIpc();
        const connects: number[] = [];
        const { link: l, starts } = link({
            connect: async () => {
                connects.push(connects.length);

                if (connects.length === 1) return asIpc(failed);
                if (connects.length === 2) throw new DaemonNotRunningError();

                return asIpc(working);
            },
        });

        await expect(l.request("x")).rejects.toThrow("The browser could not be started");
        await expect(l.request("echo")).resolves.toEqual({});
        expect(starts).toHaveLength(1);
        expect(working.calls.map((call) => call.method)).toEqual(["session.open", "echo"]);
    });

    it("keeps the generic message when no reason arrived", async () => {
        const ipc = new FakeIpc(() => {
            ipc.drop();

            throw new IpcClosedError("gone");
        });
        const { link: l } = link({ connect: async () => asIpc(ipc) });
        const failure = await l.request("x").catch((error: unknown) => error);

        expect((failure as Error).message).toContain("The daemon stopped while opening a session.");
    });
});

describe("connecting to a running daemon", () => {
    it("connects, opens one session and forwards requests", async () => {
        const ipc = new FakeIpc((method) => (method === "echo" ? "pong" : {}));
        const { link: l, starts, connects } = link({ connect: async () => asIpc(ipc) });

        await expect(l.request("echo", { a: 1 })).resolves.toBe("pong");
        await l.request("echo");
        expect(starts).toEqual([]);
        expect(ipc.calls.filter((call) => call.method === "session.open")).toHaveLength(1);
        expect(connects).toEqual([]);
    });

    it("tells the daemon which configuration it expects", async () => {
        const seen: DaemonIdentity[] = [];
        const { link: l } = link({
            connect: async (expect) => {
                seen.push(expect);

                return asIpc(new FakeIpc());
            },
        });

        await l.request("x");
        expect(seen).toEqual([identity]);
    });

    it.each([
        [undefined, false],
        [false, false],
        [true, true],
    ])("opens a session with isolated=%s as %s", async (isolated, expected) => {
        const ipc = new FakeIpc();
        const { link: l } = link({ connect: async () => asIpc(ipc) }, isolated);

        await l.request("x");
        expect(ipc.calls[0]).toEqual({
            method : "session.open",
            params : { isolated: expected },
            options: undefined,
        });
    });

    it("shares one connection and one session between concurrent first requests", async () => {
        const ipc = new FakeIpc();
        const connect = vi.fn(async () => asIpc(ipc));
        const { link: l } = link({ connect });

        await Promise.all([l.request("a"), l.request("b"), l.request("c")]);
        expect(connect).toHaveBeenCalledTimes(1);
        expect(ipc.calls.filter((call) => call.method === "session.open")).toHaveLength(1);
    });

    it("does not retry or start a daemon when the configuration does not match", async () => {
        const connect = vi.fn(async () => {
            throw new DaemonConfigMismatchError(
                "browser firefox in attach mode",
                "browser chrome in managed mode",
            );
        });
        const { link: l, starts } = link({ connect });

        await expect(l.request("x")).rejects.toBeInstanceOf(DaemonConfigMismatchError);
        expect(connect).toHaveBeenCalledTimes(1);
        expect(starts).toEqual([]);
    });

    it("does not start a daemon for errors that are not about reachability", async () => {
        const { link: l, starts } = link({
            connect: async () => {
                throw new DaemonError("Cannot read the daemon token file (EACCES). Check its permissions.");
            },
        });

        await expect(l.request("x")).rejects.toThrow(/Check its permissions/);
        expect(starts).toEqual([]);
    });

    it("passes other errors of the session handshake through unchanged", async () => {
        const ipc = new FakeIpc((method) => {
            if (method === "session.open") throw new RpcError(ErrorCode.badRequest, "no");

            return {};
        });
        const { link: l } = link({ connect: async () => asIpc(ipc) });

        await expect(l.request("x")).rejects.toMatchObject({ code: ErrorCode.badRequest, message: "no" });
    });

    it("explains how to recover when an older daemon rejects session settings", async () => {
        const ipc = new FakeIpc((method) => {
            if (method === "session.open") {
                throw new RpcError(ErrorCode.badRequest, 'Invalid parameters for session.open: check unknown field "uploadDirs".');
            }

            return {};
        });
        const { link: l, starts } = link({ connect: async () => asIpc(ipc) });
        const failure = await l.request("x").catch((error: unknown) => error);

        expect(failure).toMatchObject({ code: ErrorCode.badRequest });
        expect((failure as Error).message).toContain("daemon stop");
        expect((failure as Error).message).toContain("older");
        expect(ipc.closes).toBe(1);
        expect(starts).toEqual([]);
    });

    it("forwards the request timeout to the daemon connection", async () => {
        const ipc = new FakeIpc((method) => (method === "echo" ? "pong" : {}));
        const { link: l } = link({ connect: async () => asIpc(ipc) });

        await l.request("echo", { a: 1 }, { timeoutMs: 500 });
        expect(ipc.calls.find((call) => call.method === "echo")).toMatchObject({
            options: { timeoutMs: 500 },
        });
    });
});

describe("starting the daemon", () => {
    function comesUpAfter(polls: number) {
        let attempts = 0;
        const ipc = new FakeIpc();

        return {
            ipc,
            connect: async () => {
                attempts += 1;
                if (attempts <= polls) throw new DaemonNotRunningError();

                return asIpc(ipc);
            },
        };
    }

    it("starts it once and polls until it answers", async () => {
        const { connect, ipc } = comesUpAfter(4);
        const sleeps: number[] = [];
        const { link: l, starts } = link({ connect, sleep: async (ms) => void sleeps.push(ms) });

        await l.request("x");
        expect(starts).toHaveLength(1);
        expect(sleeps).toHaveLength(4);
        expect(ipc.calls[0]?.method).toBe("session.open");
    });

    it("starts it once for concurrent requests", async () => {
        const { connect } = comesUpAfter(3);
        const { link: l, starts } = link({ connect });

        await Promise.all([l.request("a"), l.request("b")]);
        expect(starts).toHaveLength(1);
    });

    it("treats a connection closed during the handshake as an absent daemon", async () => {
        let attempts = 0;
        const ipc = new FakeIpc();
        const { link: l, starts } = link({
            connect: async () => {
                attempts += 1;
                if (attempts === 1) throw new IpcClosedError("the daemon rejected the handshake");
                if (attempts === 2) throw new DaemonNotRunningError();

                return asIpc(ipc);
            },
        });

        await l.request("x");
        expect(starts).toHaveLength(1);
    });

    it("gives up with the log file and the last error named when the daemon never answers", async () => {
        const time = fakeClock();
        const { link: l, starts } = link({
            startTimeoutMs: 40,
            now           : time.now,
            sleep         : time.sleep,
            connect       : async () => {
                throw new IpcClosedError("connection refused");
            },
        });
        const failure = await l.request("x").catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(DaemonError);
        expect((failure as Error).message).toContain("did not start within 40 ms");
        expect((failure as Error).message).toContain("/data/daemon.log");
        expect((failure as Error).message).toContain("connection refused");
        expect(starts).toHaveLength(1);
    });

    it("retries a handshake timeout while the daemon starts instead of failing", async () => {
        let attempts = 0;
        const ipc = new FakeIpc();
        const { link: l, starts } = link({
            connect: async () => {
                attempts += 1;
                if (attempts <= 2) throw new IpcTimeoutError("hello", 5);

                return asIpc(ipc);
            },
        });

        await l.request("x");
        expect(attempts).toBe(3);
        expect(starts).toHaveLength(1);
    });

    it("fails fast on a non-reachability error in the middle of polling", async () => {
        let attempts = 0;
        const { link: l, starts } = link({
            connect: async () => {
                attempts += 1;
                if (attempts === 1) throw new DaemonNotRunningError();

                throw new DaemonConfigMismatchError("running a", "expected b");
            },
        });

        await expect(l.request("x")).rejects.toBeInstanceOf(DaemonConfigMismatchError);
        expect(starts).toHaveLength(1);
    });

    it("wraps a failing restart of an exited daemon with the cause", async () => {
        let started = 0;
        const { link: l } = link({
            startDaemon: async () => {
                started += 1;
                if (started === 1) return { exited: Promise.resolve() };

                throw new Error("port in use");
            },
        });
        const failure = await l.request("x").catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(DaemonError);
        expect((failure as Error).message).toContain("port in use");
        expect((failure as Error).message).toContain("/data/daemon.log");
    });

    it("starts the daemon again when the first process exits without answering", async () => {
        let started = 0;
        const ipc = new FakeIpc();
        let answering = false;
        const { link: l } = link({
            connect: async () => {
                if (!answering) throw new DaemonNotRunningError();

                return asIpc(ipc);
            },
            startDaemon: async () => {
                started += 1;
                if (started === 1) return { exited: Promise.resolve() };

                answering = true;

                return alive;
            },
        });

        await l.request("x");
        expect(started).toBe(2);
    });

    it("stops starting after three attempts", async () => {
        let started = 0;
        const time = fakeClock();
        const { link: l } = link({
            startTimeoutMs: 60,
            now           : time.now,
            sleep         : time.sleep,
            startDaemon   : async () => {
                started += 1;

                return { exited: Promise.resolve() };
            },
        });

        await expect(l.request("x")).rejects.toThrow(/did not start/);
        expect(started).toBe(3);
    });

    it("names the cause and the log when the process cannot be started", async () => {
        const { link: l } = link({
            startDaemon: async () => {
                throw new Error("spawn EACCES");
            },
        });
        const failure = await l.request("x").catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(DaemonError);
        expect((failure as Error).message).toContain("spawn EACCES");
        expect((failure as Error).message).toContain("/data/daemon.log");
    });

    it("tolerates a started daemon whose exit promise rejects", async () => {
        let started = 0;
        const ipc = new FakeIpc();
        const { link: l } = link({
            connect: async () => {
                if (started < 2) throw new DaemonNotRunningError();

                return asIpc(ipc);
            },
            startDaemon: async () => {
                started += 1;

                return { exited: Promise.reject(new Error("watch failed")) };
            },
        });

        await expect(l.request("x")).resolves.toEqual({});
        expect(started).toBe(2);
    });
});

describe("waiting for the browser", () => {
    function notReady(states: string[], then: "ready" | "stay") {
        const ipc = new FakeIpc((method) => {
            if (method === "daemon.status") return { state: states.shift() ?? "starting" };

            return {};
        });
        let gate = then === "ready" ? 0 : Number.POSITIVE_INFINITY;
        const original = ipc.request.bind(ipc);

        ipc.request = async (method, params) => {
            if (method === "session.open" && gate > 0) {
                gate -= 1;

                throw new RpcError(ErrorCode.browserNotReady, "The browser is not ready yet.");
            }

            return original(method, params);
        };

        return { ipc, release: () => void (gate = 0) };
    }

    it("waits while the daemon is only starting its browser", async () => {
        let remaining = 3;
        const ipc = new FakeIpc((method) => (method === "daemon.status" ? { state: "starting" } : {}));
        const base = ipc.request.bind(ipc);

        ipc.request = async (method, params) => {
            if (method === "session.open" && remaining > 0) {
                remaining -= 1;

                throw new RpcError(ErrorCode.browserNotReady, "starting");
            }

            return base(method, params);
        };

        const sleeps: number[] = [];
        const { link: l } = link({
            connect: async () => asIpc(ipc),
            sleep  : async (ms) => void sleeps.push(ms),
        });

        await expect(l.request("x")).resolves.toEqual({});
        expect(sleeps).toHaveLength(3);
    });

    it("retries when the browser became ready between the refusal and the status check", async () => {
        const ipc = new FakeIpc((method) => (method === "daemon.status" ? { state: "ready" } : {}));
        const base = ipc.request.bind(ipc);
        let refused = 0;

        ipc.request = async (method, params) => {
            if (method === "session.open" && refused === 0) {
                refused += 1;

                throw new RpcError(ErrorCode.browserNotReady, "starting");
            }

            return base(method, params);
        };

        const { link: l } = link({ connect: async () => asIpc(ipc), sleep: async () => undefined });

        await expect(l.request("x")).resolves.toEqual({});
        expect(refused).toBe(1);
    });

    it("reports the instructions at once when the user has to act", async () => {
        const { ipc } = notReady(["waiting"], "stay");
        const connect = vi.fn(async () => asIpc(ipc));
        const sleeps: number[] = [];
        const { link: l } = link({ connect, sleep: async (ms) => void sleeps.push(ms) });
        const failure = await l.request("x").catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(DaemonNotReadyError);
        expect((failure as Error).message).toContain("The browser is not ready yet.");
        expect(sleeps).toEqual([]);
    });

    it("keeps the connection and succeeds once the user has enabled remote debugging", async () => {
        const { ipc, release } = notReady(["waiting", "waiting"], "stay");
        const connect = vi.fn(async () => asIpc(ipc));
        const { link: l } = link({ connect });

        await expect(l.request("x")).rejects.toBeInstanceOf(DaemonNotReadyError);
        release();
        await expect(l.request("x")).resolves.toEqual({});
        expect(connect).toHaveBeenCalledTimes(1);
    });

    it("gives up waiting for a browser that stays in the starting state", async () => {
        const { ipc } = notReady(
            Array.from({ length: 1000 }, () => "starting"),
            "stay",
        );
        const time = fakeClock();
        const { link: l } = link({
            connect       : async () => asIpc(ipc),
            startTimeoutMs: 40,
            now           : time.now,
            sleep         : time.sleep,
        });

        await expect(l.request("x")).rejects.toBeInstanceOf(DaemonNotReadyError);
    });

    it("still reports not ready when the status cannot be read", async () => {
        const ipc = new FakeIpc((method) => {
            if (method === "daemon.status") throw new RpcError(ErrorCode.internal, "boom");

            throw new RpcError(ErrorCode.browserNotReady, "not ready");
        });
        const { link: l } = link({ connect: async () => asIpc(ipc) });

        await expect(l.request("x")).rejects.toBeInstanceOf(DaemonNotReadyError);
    });

    it("treats a dead connection during the status check as lost, not as not ready", async () => {
        const ipc = new FakeIpc((method) => {
            if (method === "daemon.status") throw new IpcClosedError("the daemon went away");

            throw new RpcError(ErrorCode.browserNotReady, "not ready");
        });
        const { link: l } = link({ connect: async () => asIpc(ipc) });

        const failure = await l.request("x").catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(DaemonError);
        expect(failure).not.toBeInstanceOf(DaemonNotReadyError);
        expect((failure as Error).message).toBe(
            "The daemon stopped while opening a session. See /data/daemon.log for its messages.",
        );
        expect(ipc.closes).toBe(1);
        const second = new FakeIpc();
        const { link: retry } = link({ connect: async () => asIpc(second) });

        await expect(retry.request("x")).resolves.toEqual({});
        expect(second.calls[0]?.method).toBe("session.open");
    });
});

describe("losing the daemon", () => {
    it("reconnects with a new session on the next request after the connection dropped", async () => {
        const first = new FakeIpc();
        const second = new FakeIpc();
        const clients = [first, second];
        const { link: l } = link({ connect: async () => asIpc(clients.shift() ?? second) });

        await l.request("a");
        first.drop();
        await l.request("b");
        expect(second.calls.map((call) => call.method)).toEqual(["session.open", "b"]);
    });

    it("does not repeat a request that failed because the connection dropped", async () => {
        const first = new FakeIpc((method) => {
            if (method === "risky") throw new IpcClosedError("the daemon closed the connection");

            return {};
        });
        const second = new FakeIpc();
        const clients = [first, second];
        const { link: l } = link({ connect: async () => asIpc(clients.shift() ?? second) });

        await l.request("warm");
        await expect(l.request("risky")).rejects.toBeInstanceOf(IpcClosedError);
        expect(second.calls).toEqual([]);
        first.drop();
        await l.request("again");
        expect(second.calls.map((call) => call.method)).toEqual(["session.open", "again"]);
    });

    it("starts a daemon again when it vanished completely", async () => {
        const first = new FakeIpc();
        const second = new FakeIpc();
        let phase: "first" | "gone" | "back" = "first";
        let started = 0;
        const { link: l } = link({
            connect: async () => {
                if (phase === "first") {
                    phase = "gone";

                    return asIpc(first);
                }

                if (phase === "gone") throw new DaemonNotRunningError();

                return asIpc(second);
            },
            startDaemon: async () => {
                started += 1;
                phase = "back";

                return alive;
            },
        });

        await l.request("a");
        first.drop();
        await l.request("b");
        expect(started).toBe(1);
        expect(second.calls.at(-1)?.method).toBe("b");
    });
});

describe("failures while establishing", () => {
    it("closes the connection when the session cannot be opened for another reason", async () => {
        const first = new FakeIpc((method) => {
            if (method === "session.open") throw new RpcError(ErrorCode.badRequest, "no");

            return {};
        });
        const second = new FakeIpc();
        const clients = [first, second];
        const { link: l } = link({ connect: async () => asIpc(clients.shift() ?? second) });

        await expect(l.request("x")).rejects.toMatchObject({ code: ErrorCode.badRequest });
        expect(first.closes).toBe(1);
        await l.request("again");
        expect(second.calls.map((call) => call.method)).toEqual(["session.open", "again"]);
    });
});

describe("session generations", () => {
    it("raises the generation on every new session and notifies reset handlers", async () => {
        const first = new FakeIpc();
        const second = new FakeIpc();
        const third = new FakeIpc();
        const clients = [first, second, third];
        const { link: l } = link({ connect: async () => asIpc(clients.shift() ?? second) });
        const generations: number[] = [];
        const off = l.onSessionReset(() => generations.push(l.sessionGeneration));

        expect(l.sessionGeneration).toBe(0);
        await l.request("a");
        expect(l.sessionGeneration).toBe(1);
        expect(generations).toEqual([1]);
        first.drop();
        await l.request("b");
        expect(l.sessionGeneration).toBe(2);
        expect(generations).toEqual([1, 2]);
        off();
        second.drop();
        await l.request("c");
        expect(l.sessionGeneration).toBe(3);
        expect(generations).toEqual([1, 2]);
    });
});

describe("closing", () => {
    it("does not leak a connection that finishes opening after the link was closed", async () => {
        const ipc = new FakeIpc();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const { link: l } = link({
            connect: async () => {
                await gate;

                return asIpc(ipc);
            },
        });
        const pending = l.request("x").catch((error: unknown) => error);

        await Promise.resolve();
        const closing = l.close();

        release();
        await closing;
        expect(ipc.closes).toBe(1);
        expect(await pending).toBeInstanceOf(IpcClosedError);
        expect(ipc.calls).toEqual([]);
    });

    it("does not keep a session that was opened while the link was closing", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const ipc = new FakeIpc(async (method) => {
            if (method === "session.open") await gate;

            return {};
        });
        const { link: l } = link({ connect: async () => asIpc(ipc) });
        const pending = l.request("x").catch((error: unknown) => error);

        await vi.waitFor(() => expect(ipc.calls).toHaveLength(1));
        const closing = l.close();

        release();
        await closing;
        expect(await pending).toBeInstanceOf(IpcClosedError);
        expect(ipc.closed).toBe(true);
    });

    it("closes the connection once and refuses further requests", async () => {
        const ipc = new FakeIpc();
        const { link: l } = link({ connect: async () => asIpc(ipc) });

        await l.request("a");
        await l.close();
        await l.close();
        expect(ipc.closes).toBe(1);
        await expect(l.request("b")).rejects.toBeInstanceOf(IpcClosedError);
    });

    it("stops polling for the daemon as soon as the link is closed", async () => {
        let polls = 0;
        const sleeps: number[] = [];
        let releaseSleep: () => void = () => undefined;
        const { link: l, starts } = link({
            startTimeoutMs: 60_000,
            now           : () => 0,
            sleep         : async (ms) => {
                sleeps.push(ms);
                await new Promise<void>((resolve) => (releaseSleep = resolve));
            },
            connect: async () => {
                polls += 1;

                throw new DaemonNotRunningError();
            },
        });
        const pending = l.request("x").catch((error: unknown) => error);

        await vi.waitFor(() => expect(polls).toBe(1));
        await vi.waitFor(() => expect(sleeps).toHaveLength(1));
        releaseSleep();
        await vi.waitFor(() => expect(polls).toBe(2));
        const closing = l.close();

        releaseSleep();
        await closing;
        expect(await pending).toBeInstanceOf(IpcClosedError);
        expect(starts).toHaveLength(1);
        expect(polls).toBe(2);
    });

    it("stops waiting for the browser as soon as the link is closed", async () => {
        const ipc = new FakeIpc((method) => {
            if (method === "daemon.status") return { state: "starting" };

            throw new RpcError(ErrorCode.browserNotReady, "not ready");
        });
        let releaseSleep: () => void = () => undefined;
        const { link: l } = link({
            connect       : async () => asIpc(ipc),
            startTimeoutMs: 60_000,
            now           : () => 0,
            sleep         : async () => {
                await new Promise<void>((resolve) => (releaseSleep = resolve));
            },
        });
        const pending = l.request("x").catch((error: unknown) => error);
        const opens = () => ipc.calls.filter((call) => call.method === "session.open");

        await vi.waitFor(() => expect(opens()).toHaveLength(1));
        const closing = l.close();

        releaseSleep();
        await closing;
        expect(await pending).toBeInstanceOf(IpcClosedError);
        expect(opens()).toHaveLength(1);
        expect(ipc.closes).toBeGreaterThanOrEqual(1);
    });

    it("is safe to close before the first request", async () => {
        const { link: l } = link();

        await expect(l.close()).resolves.toBeUndefined();
        await expect(l.ready()).rejects.toBeInstanceOf(IpcClosedError);
    });
});
