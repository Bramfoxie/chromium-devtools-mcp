import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config/index.js";
import { CdpClient } from "../src/cdp/index.js";
import {
  AlreadyRunningError,
  type BrowserConnector,
  connectToDaemon,
  DaemonConfigMismatchError,
  DaemonError,
  DaemonNotRunningError,
  type DaemonLayout,
  type DaemonOutcome,
  ErrorCode,
  IpcClient,
  RpcError,
  runDaemon,
  type RunningDaemon,
} from "../src/daemon/index.js";
import { FakeBrowser } from "./helpers/fake-browser.js";
import { createSocketHarness } from "./helpers/daemon-socket.js";

const harness = createSocketHarness();

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

const config: Config = {
  browser   : "chrome",
  mode      : "managed",
  headless  : true,
  profileDir: "/unused",
  debugPort : 9222,
  allowFocus: false,
  safety    : { readOnly: false, allowedDomains: [], confirmDangerous: false },
};

async function makeLayout(): Promise<DaemonLayout> {
  const options = await harness.options();
  const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-token-"));

  harness.track(() => rm(dir, { recursive: true, force: true }));

  return {
    tokenFile : path.join(dir, "daemon.token"),
    platform  : options.platform,
    uid       : options.uid,
    socketPath: () => options.socketPath,
    instance  : () => options,
  };
}

interface Recorded {
  stops         : number;
  contextsAtStop: number[];
}

async function startFakeBrowser() {
  const browser = new FakeBrowser();
  const url = await browser.start();

  harness.track(() => browser.stop());
  const recorded: Recorded = { stops: 0, contextsAtStop: [] };
  const connect: BrowserConnector = async () => {
    const client = await CdpClient.connect({ url, requestTimeoutMs: 2000 });

    return {
      client,
      stop: async () => {
        recorded.stops += 1;
        recorded.contextsAtStop.push(browser.contexts.size);
        await client.close();
      },
    };
  };

  return { browser, recorded, connect };
}

async function start(
  layout: DaemonLayout,
  connectBrowser: BrowserConnector,
  overrides: { idleTimeoutMs?: number; cfg?: Config } = {},
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
  layout: DaemonLayout,
  name = "test",
  expect?: { browser: string; mode: string },
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
    const layout = await makeLayout();
    const { browser, connect: connector } = await startFakeBrowser();

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
    const layout = await makeLayout();
    const { connect: connector } = await startFakeBrowser();

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
    const layout = await makeLayout();
    const { connect: connector } = await startFakeBrowser();
    const first = await start(layout, connector, { idleTimeoutMs: 20 });
    const token = (await readFile(layout.tokenFile, "utf8")).trim();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await first.done;
    const second = await start(layout, connector);

    expect((await readFile(layout.tokenFile, "utf8")).trim()).toBe(token);
    await second.stop();
  });

  it("leaves no timer behind when another daemon already runs", async () => {
    const layout = await makeLayout();
    const { connect: connector } = await startFakeBrowser();

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
        identity     : { browser: "chrome", mode: "attach" },
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
    const layout = await makeLayout();
    const { connect: connector } = await startFakeBrowser();

    await start(layout, connector);
    await expect(
      runDaemon(config, { layout, connectBrowser: connector, idleTimeoutMs: 60_000 }),
    ).rejects.toBeInstanceOf(AlreadyRunningError);
    const client = await connect(layout);

    await ready(client);
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
    const layout = await makeLayout();
    const { connect: connector } = await startFakeBrowser();
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
    const layout = await makeLayout();
    const { connect: connector } = await startFakeBrowser();
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

  it("keeps waiting for the browser longer than the idle timeout while nobody is connected", async () => {
    const layout = await makeLayout();
    const { connect: connector } = await startFakeBrowser();
    const gate = gated();
    const running = await start(layout, gate.wrap(connector), { idleTimeoutMs: 80 });

    gate.announce("Open chrome://inspect and turn on remote debugging.");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await settled(running)).toBe("pending");
    gate.release();
    expect((await running.done).reason).toBe("idle");
  });

  it("aborts the wait for the browser on stop", async () => {
    const layout = await makeLayout();
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
    const layout = await makeLayout();
    const { connect: inner, recorded } = await startFakeBrowser();
    const gate = gated();
    const running = await start(layout, gate.wrap(inner));

    await running.stop();
    gate.release();
    await vi.waitFor(() => expect(recorded.stops).toBe(1));
  });

  it("fails and frees the socket when the browser cannot be reached", async () => {
    const layout = await makeLayout();
    const connector: BrowserConnector = async () => {
      throw new Error("browser refused");
    };
    const running = await start(layout, connector);
    const outcome = await running.done;

    expect(outcome.reason).toBe("failed");
    expect(outcome.error?.message).toBe("browser refused");
    const { connect: working } = await startFakeBrowser();
    const next = await start(layout, working);

    await next.stop();
  });

  it("fails when the browser does not report its default context", async () => {
    const layout = await makeLayout();
    const { browser, connect: connector, recorded } = await startFakeBrowser();

    browser.reportDefaultContext = false;
    const running = await start(layout, connector);

    expect((await running.done).reason).toBe("failed");
    expect(recorded.stops).toBe(1);
  });
});

describe("stopping", () => {
  it("closes the sessions before the browser and is idempotent", async () => {
    const layout = await makeLayout();
    const { browser, recorded, connect: connector } = await startFakeBrowser();
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
    const layout = await makeLayout();
    const { connect: connector } = await startFakeBrowser();
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
    const layout = await makeLayout();
    const { connect: connector } = await startFakeBrowser();
    const first = await start(layout, connector);

    await first.stop();
    const second = await start(layout, connector);
    const client = await connect(layout);

    await ready(client);
    await second.stop();
  });

  it("stops when the browser connection is lost", async () => {
    const layout = await makeLayout();
    const { browser, connect: connector } = await startFakeBrowser();
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

describe("idle shutdown", () => {
  it("stops after the last client leaves", async () => {
    const layout = await makeLayout();
    const { recorded, connect: connector } = await startFakeBrowser();
    const running = await start(layout, connector, { idleTimeoutMs: 80 });
    const client = await connect(layout);

    await ready(client);
    expect(await settled(running)).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await settled(running)).toBe("pending");
    await client.close();
    expect((await running.done).reason).toBe("idle");
    expect(recorded.stops).toBe(1);
  });

  it("stays alive while a second client is connected and counts again after a reconnect", async () => {
    const layout = await makeLayout();
    const { connect: connector } = await startFakeBrowser();
    const running = await start(layout, connector, { idleTimeoutMs: 100 });
    const first = await connect(layout, "first");
    const second = await connect(layout, "second");

    await ready(first);
    await first.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await settled(running)).toBe("pending");
    await second.close();
    const third = await connect(layout, "third");

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await settled(running)).toBe("pending");
    await third.close();
    expect((await running.done).reason).toBe("idle");
  });

  it("stops when nobody ever connects", async () => {
    const layout = await makeLayout();
    const { connect: connector } = await startFakeBrowser();
    const running = await start(layout, connector, { idleTimeoutMs: 60 });

    expect((await running.done).reason).toBe("idle");
  });

  it("does not count a connection that never authenticated", async () => {
    const layout = await makeLayout();
    const { connect: connector } = await startFakeBrowser();
    const running = await start(layout, connector, { idleTimeoutMs: 80 });
    const net = await import("node:net");
    const socket = net.connect(layout.socketPath("x"));

    socket.on("error", () => undefined);
    harness.track(async () => void socket.destroy());
    expect((await running.done).reason).toBe("idle");
  });
});

describe("daemon status", () => {
  it("does not fall back to waiting once the backend is attached", async () => {
    const { Daemon } = await import("../src/daemon/index.js");
    const { FakeBackend } = await import("./helpers/fake-backend.js");
    const daemon = new Daemon({
      token     : "t",
      allowFocus: false,
      identity  : { browser: "chrome", mode: "attach" },
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
    const layout = await makeLayout();

    await expect(connectToDaemon({ layout, clientName: "x" })).rejects.toBeInstanceOf(
      DaemonNotRunningError,
    );
  });

  it("wraps an unreadable token file in a DaemonError with a hint", async () => {
    const layout = await makeLayout();
    const directoryAsToken = { ...layout, tokenFile: path.dirname(layout.tokenFile) };
    const failure = await connectToDaemon({ layout: directoryAsToken, clientName: "x" }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DaemonError);
    expect((failure as Error).message).toContain("Check its permissions");
  });

  it("fails clearly when the token is stale and nothing listens", async () => {
    const layout = await makeLayout();
    const { connect: connector } = await startFakeBrowser();
    const running = await start(layout, connector);

    await running.stop();
    await expect(connectToDaemon({ layout, clientName: "x" })).rejects.toThrow(
      /cannot reach the daemon/,
    );
  });

  it("accepts a client whose expectation matches the daemon", async () => {
    const layout = await makeLayout();
    const { connect: connector } = await startFakeBrowser();

    await start(layout, connector);
    const client = await connect(layout, "ok", { browser: "chrome", mode: "managed" });

    expect(client.helloResult).toMatchObject({
      ok    : true,
      daemon: { browser: "chrome", mode: "managed" },
    });
  });

  it.each([
    [{ browser: "arc", mode: "managed" }, "browser arc in managed mode"],
    [{ browser: "chrome", mode: "attach" }, "browser chrome in attach mode"],
  ])("refuses a client that expects %j", async (expected, text) => {
    const layout = await makeLayout();
    const { connect: connector } = await startFakeBrowser();

    await start(layout, connector);
    const failure = await connectToDaemon({ layout, clientName: "x", expect: expected }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DaemonConfigMismatchError);
    expect((failure as Error).message).toContain("browser chrome in managed mode");
    expect((failure as Error).message).toContain(text);
  });

  it("closes the connection of a client that was refused", async () => {
    const layout = await makeLayout();
    const { connect: connector } = await startFakeBrowser();
    const running = await start(layout, connector, { idleTimeoutMs: 100 });

    await connectToDaemon({
      layout,
      clientName: "x",
      expect    : { browser: "arc", mode: "attach" },
    }).catch(() => undefined);
    expect((await running.done).reason).toBe("idle");
  });
});
