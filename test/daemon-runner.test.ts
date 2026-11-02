import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config/index.js";
import {
    AlreadyRunningError,
    type BrowserConnector,
    connectToDaemon,
    DaemonConfigMismatchError,
    DaemonError,
    type DaemonIdentity,
    daemonIdentity,
    DaemonNotRunningError,
    type DaemonLayout,
    type DaemonOutcome,
    ErrorCode,
    IpcClient,
    RpcError,
    approvalMessage,
    runDaemon,
    type RunningDaemon,
} from "../src/daemon/index.js";
import { makeLayout, startFakeBrowser } from "./helpers/daemon-env.js";
import { createSocketHarness } from "./helpers/daemon-socket.js";

const harness = createSocketHarness();

afterEach(async () => {
    await harness.dispose();
    vi.restoreAllMocks();
});

const config: Config = {
    browser   : "chrome",
    mode      : "managed",
    headless  : true,
    profileDir: "/unused",
    debugPort : 9222,
    allowFocus: false,
    isolated  : false,
    safety    : { readOnly: false, allowedDomains: [], confirmDangerous: false },
};

async function start(
    layout        : DaemonLayout,
    connectBrowser: BrowserConnector,
    overrides     : { idleTimeoutMs?: number; cfg?: Config } = {},
): Promise<RunningDaemon> {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const running = await runDaemon(overrides.cfg ?? config, {
        layout,
        connectBrowser,
        idleTimeoutMs: overrides.idleTimeoutMs ?? 60_000,
    });

    harness.track(async () => void (await running.stop()));

    return running;
}

async function connect(
    layout : DaemonLayout,
    name = "test",
    expect?: DaemonIdentity,
) {
    const client = await connectToDaemon({ layout, clientName: name, expect });

    harness.track(() => client.close());

    return client;
}

async function ready(client: IpcClient): Promise<void> {
    await vi.waitFor(async () => {
        const status = (await client.request("daemon.status")) as { state: string };

        expect(status.state).toBe("ready");
    });
}

async function settled(running: RunningDaemon): Promise<DaemonOutcome | "pending"> {
    return Promise.race([
        running.done,
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
}

describe("starting and serving", () => {
    it("becomes ready, serves isolated sessions and cleans up when the client leaves", async () => {
        const layout = await makeLayout(harness);
        const { browser, connect: connector } = await startFakeBrowser(harness);

        await start(layout, connector);
        const client = await connect(layout);

        await ready(client);
        await client.request("session.open", { isolated: true });
        const { targetId } = (await client.request("tab.create", { url: "https://a.example/" })) as {
            targetId: string;
        };

        expect(browser.targets.get(targetId)?.url).toBe("https://a.example/");
        await client.close();
        await vi.waitFor(() => expect(browser.contexts.size).toBe(0));
    });

    it("keeps the clients of one daemon apart", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);

        await start(layout, connector);
        const alice = await connect(layout, "alice");
        const bob = await connect(layout, "bob");

        await ready(alice);
        await alice.request("session.open", { isolated: true });
        await bob.request("session.open", { isolated: true });
        const { targetId } = (await alice.request("tab.create")) as { targetId: string };
        const failure = await bob
            .request("cdp.send", { targetId, method: "Page.enable" })
            .catch((error: unknown) => error);

        expect((failure as RpcError).code).toBe(ErrorCode.notOwned);
    });

    it("creates the token once and reuses it on the next start", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);
        const first = await start(layout, connector, { idleTimeoutMs: 20 });
        const token = (await readFile(layout.tokenFile, "utf8")).trim();

        expect(token).toMatch(/^[0-9a-f]{64}$/);
        await first.done;
        const second = await start(layout, connector);

        expect((await readFile(layout.tokenFile, "utf8")).trim()).toBe(token);
        await second.stop();
    });

    it("leaves no timer behind when another daemon already runs", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);

        await start(layout, connector, { idleTimeoutMs: 60_000 });
        await ready(await connect(layout));
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

        try {
            await expect(
                runDaemon(config, { layout, connectBrowser: connector, idleTimeoutMs: 60_000 }),
            ).rejects.toBeInstanceOf(AlreadyRunningError);

            for (let tick = 0; tick < 200 && vi.getTimerCount() > 0; tick += 1) {
                await new Promise((resolve) => setImmediate(resolve));
            }

            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not start the idle timer when a daemon is only constructed", async () => {
        const { Daemon } = await import("../src/daemon/index.js");

        vi.useFakeTimers();

        try {
            const daemon = new Daemon({
                token        : "t",
                allowFocus   : false,
                identity     : { browser: "chrome", mode: "attach", debugPort: 9222, allowFocus: false },
                idleTimeoutMs: 50,
                onIdle       : () => {
                    throw new Error("must not fire");
                },
            });

            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(1000);
            await daemon.shutdown();
        } finally {
            vi.useRealTimers();
        }
    });

    it("refuses a second daemon for the same user and leaves the first one working", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);

        await start(layout, connector);
        await expect(
            runDaemon(config, { layout, connectBrowser: connector, idleTimeoutMs: 60_000 }),
        ).rejects.toBeInstanceOf(AlreadyRunningError);
        const client = await connect(layout);

        await ready(client);
    });

    it("refuses to overwrite a missing token when the socket is alive", async () => {
        const layout: DaemonLayout = { ...(await makeLayout(harness)), platform: "linux" };
        const { connect: connector } = await startFakeBrowser(harness);

        await expect(
            runDaemon(config, {
                layout,
                connectBrowser: connector,
                idleTimeoutMs : 60_000,
                probe         : async () => "alive",
            }),
        ).rejects.toBeInstanceOf(AlreadyRunningError);
        await expect(readFile(layout.tokenFile, "utf8")).rejects.toThrow();
    });
});

describe("waiting for the browser", () => {
    function gated() {
        let release: () => void = () => undefined;
        let waiting: (message: string) => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));

        return {
            release : () => release(),
            announce: (message: string) => waiting(message),
            wrap:
        (inner: BrowserConnector): BrowserConnector =>
            async (cfg, hooks, signal) => {
                waiting = hooks.onWaiting;
                await gate;

                return inner(cfg, hooks, signal);
            },
        };
    }

    it("reports the starting state and refuses sessions until the browser is ready", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);
        const gate = gated();

        await start(layout, gate.wrap(connector));
        const client = await connect(layout);

        expect(await client.request("daemon.status")).toMatchObject({
            state  : "starting",
            browser: "chrome",
            mode   : "managed",
        });
        const failure = await client.request("session.open").catch((error: unknown) => error);

        expect((failure as RpcError).code).toBe(ErrorCode.browserNotReady);
        gate.release();
        await ready(client);
        await expect(client.request("session.open")).resolves.toEqual({ isolated: false });
    });

    it("hands the setup instructions to the client while the browser is not enabled", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);
        const gate = gated();

        await start(layout, gate.wrap(connector));
        const client = await connect(layout);

        gate.announce("Open chrome://inspect and turn on remote debugging.");
        const status = (await client.request("daemon.status")) as { state: string; message: string };

        expect(status).toMatchObject({
            state  : "waiting",
            message: "Open chrome://inspect and turn on remote debugging.",
        });
        const failure = await client.request("session.open").catch((error: unknown) => error);

        expect((failure as RpcError).code).toBe(ErrorCode.browserNotReady);
        expect((failure as RpcError).message).toContain("chrome://inspect");
        gate.release();
        await ready(client);
        expect(
            ((await client.request("daemon.status")) as { message?: string }).message,
        ).toBeUndefined();
    });

    it("stops when nobody is connected while it waits for the browser", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);
        const gate = gated();
        const running = await start(layout, gate.wrap(connector), { idleTimeoutMs: 80 });

        gate.announce("Open chrome://inspect and turn on remote debugging.");
        expect((await running.done).reason).toBe("idle");
        gate.release();
    });

    it("keeps waiting for the browser while a client is connected", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);
        const gate = gated();
        const running = await start(layout, gate.wrap(connector), { idleTimeoutMs: 80 });
        const client = await connect(layout);

        gate.announce("Open chrome://inspect and turn on remote debugging.");
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(await settled(running)).toBe("pending");
        gate.release();
        await ready(client);
        await client.close();
        expect((await running.done).reason).toBe("idle");
    });

    it("aborts the wait for the browser on stop", async () => {
        const layout = await makeLayout(harness);
        let aborted = false;
        const connector: BrowserConnector = (_cfg, _hooks, signal) =>
            new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => {
                    aborted = true;
                    reject(new Error("cancelled"));
                });
            });
        const running = await start(layout, connector);

        expect(await running.stop()).toEqual({ reason: "requested" });
        expect(aborted).toBe(true);
    });

    it("stops a browser that finished starting after the daemon was stopped", async () => {
        const layout = await makeLayout(harness);
        const { connect: inner, recorded } = await startFakeBrowser(harness);
        const gate = gated();
        const running = await start(layout, gate.wrap(inner));

        await running.stop();
        gate.release();
        await vi.waitFor(() => expect(recorded.count).toBe(1));
    });

    it("stops the browser exactly once when stop races backend creation", async () => {
        const layout = await makeLayout(harness);
        const { browser, recorded, connect: inner } = await startFakeBrowser(harness);

        browser.silent.add("Target.getBrowserContexts");
        const running = await start(layout, inner);

        await vi.waitFor(() => {
            expect(browser.calls.some((call) => call.method === "Target.getBrowserContexts")).toBe(true);
        });
        await running.stop();
        expect(recorded.count).toBe(1);
    });

    it("fails and frees the socket when the browser cannot be reached", async () => {
        const layout = await makeLayout(harness);
        const connector: BrowserConnector = async () => {
            throw new Error("browser refused");
        };
        const running = await start(layout, connector);
        const outcome = await running.done;

        expect(outcome.reason).toBe("failed");
        expect(outcome.error?.message).toBe("browser refused");
        const { connect: working } = await startFakeBrowser(harness);
        const next = await start(layout, working);

        await next.stop();
    });

    it("fails when the browser does not report its default context", async () => {
        const layout = await makeLayout(harness);
        const { browser, connect: connector, recorded } = await startFakeBrowser(harness);

        browser.reportDefaultContext = false;
        const running = await start(layout, connector);

        expect((await running.done).reason).toBe("failed");
        expect(recorded.count).toBe(1);
    });
});

describe("stopping", () => {
    it("closes the sessions before the browser and is idempotent", async () => {
        const layout = await makeLayout(harness);
        const { browser, recorded, connect: connector } = await startFakeBrowser(harness);
        const running = await start(layout, connector);
        const client = await connect(layout);

        await ready(client);
        await client.request("session.open", { isolated: true });
        await client.request("tab.create");
        const [first, second] = await Promise.all([running.stop(), running.stop()]);

        expect(first).toEqual({ reason: "requested" });
        expect(second).toBe(first);
        expect(recorded.contextsAtStop).toEqual([0]);
        expect(browser.contexts.size).toBe(0);
        expect(client.closed || (await settledClose(client))).toBe(true);
    });

    it("leaves no timer behind when a client is still connected during the stop", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);
        const running = await start(layout, connector, { idleTimeoutMs: 100 });
        const client = await connect(layout);

        await ready(client);
        vi.useFakeTimers();

        try {
            await running.stop();
            await vi.waitFor(() => expect(client.closed).toBe(true), { interval: 5 });
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("frees the socket for a new daemon", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);
        const first = await start(layout, connector);

        await first.stop();
        const second = await start(layout, connector);
        const client = await connect(layout);

        await ready(client);
        await second.stop();
    });

    it("stops when the browser connection is lost", async () => {
        const layout = await makeLayout(harness);
        const { browser, connect: connector } = await startFakeBrowser(harness);
        const running = await start(layout, connector);
        const client = await connect(layout);

        await ready(client);
        const stderr = vi.spyOn(process.stderr, "write");

        browser.dropConnections();
        expect((await running.done).reason).toBe("browser_disconnected");
        expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
            "the browser disconnected",
        );
    });
});

async function settledClose(client: IpcClient): Promise<boolean> {
    await vi.waitFor(() => expect(client.closed).toBe(true));

    return true;
}

describe("browser failure", () => {
    it("tells a connected client why the daemon stops before closing the connection", async () => {
        const layout = await makeLayout(harness);
        const release: { go: () => void } = { go: () => undefined };
        const gate = new Promise<void>((resolve) => {
            release.go = resolve;
        });
        const connector: BrowserConnector = async () => {
            await gate;

            throw new Error("Chrome did not expose\nremote debugging " + "x".repeat(700));
        };
        const running = await start(layout, connector);
        const client = await connect(layout);
        const received: unknown[] = [];

        client.on("daemon.failed", (params) => received.push(params));
        release.go();
        await running.done;
        await settledClose(client);
        expect(received).toHaveLength(1);
        const { message } = received[0] as { message: string };

        expect(message.startsWith("Chrome did not expose remote debugging xxx")).toBe(true);
        expect(message).toHaveLength(500);
        expect(client.failure).toBe(message);
    });

    it("sends no failure message when the daemon is stopped on request", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);
        const running = await start(layout, connector);
        const client = await connect(layout);

        await running.stop();
        await settledClose(client);
        expect(client.failure).toBeUndefined();
    });

    it("reports the failure once, through the outcome", async () => {
        const layout = await makeLayout(harness);
        const connector: BrowserConnector = async () => {
            throw new Error("browser refused");
        };
        const running = await start(layout, connector);
        const outcome = await running.done;

        expect(outcome.reason).toBe("failed");
        expect(outcome.error?.message).toBe("browser refused");
        const logged = vi.mocked(process.stderr.write).mock.calls.map(([text]) => String(text));

        expect(logged.some((line) => line.includes("browser refused"))).toBe(false);
    });
});

describe("idle shutdown of a browser with a window", () => {
    function windowed(connector: BrowserConnector) {
        const calls: string[] = [];
        const wrapped: BrowserConnector = async (...args) => {
            const handle = await connector(...args);

            return {
                client : handle.client,
                stop   : async () => void (calls.push("stop"), await handle.stop()),
                release: async () => void (calls.push("release"), await handle.stop()),
            };
        };

        return { calls, wrapped };
    }

    it("releases the browser instead of stopping it", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);
        const { calls, wrapped } = windowed(connector);
        const running = await start(layout, wrapped, { idleTimeoutMs: 80 });
        const client = await connect(layout);

        await ready(client);
        await client.close();
        expect((await running.done).reason).toBe("idle");
        expect(calls).toEqual(["release"]);
    });

    it("still stops the browser on an explicit request", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);
        const { calls, wrapped } = windowed(connector);
        const running = await start(layout, wrapped);

        await ready(await connect(layout));
        await running.stop();
        expect(calls).toEqual(["stop"]);
    });
});

describe("idle shutdown", () => {
    it("stops after the last client leaves", async () => {
        const layout = await makeLayout(harness);
        const { recorded, connect: connector } = await startFakeBrowser(harness);
        const running = await start(layout, connector, { idleTimeoutMs: 80 });
        const client = await connect(layout);

        await ready(client);
        expect(await settled(running)).toBe("pending");
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await settled(running)).toBe("pending");
        await client.close();
        expect((await running.done).reason).toBe("idle");
        expect(recorded.count).toBe(1);
    });

    it("stays alive while a second client is connected and counts again after a reconnect", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);
        const running = await start(layout, connector, { idleTimeoutMs: 100 });
        const first = await connect(layout, "first");
        const second = await connect(layout, "second");

        await ready(first);
        await first.close();
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(await settled(running)).toBe("pending");
        const third = await connect(layout, "third");

        await second.close();
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(await settled(running)).toBe("pending");
        await third.close();
        expect((await running.done).reason).toBe("idle");
    });

    it("stops when nobody ever connects", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);
        const running = await start(layout, connector, { idleTimeoutMs: 60 });

        expect((await running.done).reason).toBe("idle");
    });

    it("does not count a connection that never authenticated", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);
        const running = await start(layout, connector, { idleTimeoutMs: 80 });
        const net = await import("node:net");
        const socket = net.connect(layout.socketPath("x"));

        socket.on("error", () => undefined);
        harness.track(async () => void socket.destroy());
        expect((await running.done).reason).toBe("idle");
    });
});

describe("daemon status", () => {
    it("survives a throwing onIdle without crashing the daemon", async () => {
        const { Daemon } = await import("../src/daemon/index.js");
        const { FakeBackend } = await import("./helpers/fake-backend.js");
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const daemon = new Daemon({
            token        : "t",
            allowFocus   : false,
            identity     : { browser: "chrome", mode: "attach", debugPort: 9222, allowFocus: false },
            idleTimeoutMs: 20,
            onIdle       : () => {
                throw new Error("idle boom");
            },
        });

        daemon.setBackend(new FakeBackend());
        await vi.waitFor(() =>
            expect(stderr).toHaveBeenCalledWith(expect.stringContaining("onIdle failed")),
        );
        expect(daemon.status().state).toBe("ready");
        await daemon.shutdown();
    });

    it("does not fall back to waiting once the backend is attached", async () => {
        const { Daemon } = await import("../src/daemon/index.js");
        const { FakeBackend } = await import("./helpers/fake-backend.js");
        const daemon = new Daemon({
            token     : "t",
            allowFocus: false,
            identity  : { browser: "chrome", mode: "attach", debugPort: 9222, allowFocus: false },
        });

        expect(daemon.status()).toEqual({ state: "starting", browser: "chrome", mode: "attach" });
        daemon.setWaiting("turn it on");
        expect(daemon.status()).toMatchObject({ state: "waiting", message: "turn it on" });
        daemon.setBackend(new FakeBackend());
        expect(daemon.status()).toEqual({ state: "ready", browser: "chrome", mode: "attach" });
        daemon.setWaiting("late");
        expect(daemon.status().state).toBe("ready");
        expect(daemon.status().message).toBeUndefined();
        await daemon.shutdown();
    });
});

describe("connecting to the daemon", () => {
    it("fails clearly when no daemon was ever started", async () => {
        const layout = await makeLayout(harness);

        await expect(connectToDaemon({ layout, clientName: "x" })).rejects.toBeInstanceOf(
            DaemonNotRunningError,
        );
    });

    it("wraps an unreadable token file in a DaemonError with a hint", async () => {
        const layout = await makeLayout(harness);
        const directoryAsToken = { ...layout, tokenFile: path.dirname(layout.tokenFile) };
        const failure = await connectToDaemon({ layout: directoryAsToken, clientName: "x" }).catch(
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(DaemonError);
        expect((failure as Error).message).toContain("Check its permissions");
    });

    it("fails clearly when the token is stale and nothing listens", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);
        const running = await start(layout, connector);

        await running.stop();
        await expect(connectToDaemon({ layout, clientName: "x" })).rejects.toThrow(
            /cannot reach the daemon/,
        );
    });

    it("accepts a client whose expectation matches the daemon", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);

        await start(layout, connector);
        const client = await connect(layout, "ok", daemonIdentity(config));

        expect(client.helloResult).toEqual({ ok: true, daemon: daemonIdentity(config) });
    });

    it.each([
        [daemonIdentity({ ...config, browser: "firefox" as never }), "browser chrome", "browser firefox"],
        [daemonIdentity({ ...config, mode: "attach" }), "mode managed", "mode attach"],
        [daemonIdentity({ ...config, debugPort: 9333 }), "debugPort 9222", "debugPort 9333"],
        [daemonIdentity({ ...config, debugPort: 0 }), "debugPort 9222", "debugPort 0"],
        [daemonIdentity({ ...config, allowFocus: true }), "allowFocus false", "allowFocus true"],
        [daemonIdentity({ ...config, headless: false }), "headless true", "headless false"],
        [daemonIdentity({ ...config, profileDir: "/other" }), "profileDir /unused", "profileDir /other"],
    ])("refuses a client that expects %j", async (expected, running, text) => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);

        await start(layout, connector);
        const failure = await connectToDaemon({ layout, clientName: "x", expect: expected }).catch(
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(DaemonConfigMismatchError);
        expect((failure as Error).message).toContain(`uses ${running}`);
        expect((failure as Error).message).toContain(`expects ${text}`);
    });

    it("closes the connection of a client that was refused", async () => {
        const layout = await makeLayout(harness);
        const { connect: connector } = await startFakeBrowser(harness);
        const running = await start(layout, connector, { idleTimeoutMs: 100 });

        await connectToDaemon({
            layout,
            clientName: "x",
            expect    : daemonIdentity({ ...config, browser: "firefox" as never }),
        }).catch(() => undefined);
        expect((await running.done).reason).toBe("idle");
    });
});

describe("approvalMessage", () => {
    it("asks the user to allow the connection in Chrome", () => {
        expect(approvalMessage()).toContain("If Chrome asks whether to allow remote debugging");
        expect(approvalMessage()).toContain("Connecting to Chrome.");
    });
});
