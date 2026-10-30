import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli-main.js";
import { ConfigError } from "../src/config/index.js";
import {
  AlreadyRunningError,
  type DaemonOutcome,
  type RunningDaemon,
} from "../src/daemon/index.js";

function harness(overrides: Parameters<typeof main>[1] = {}) {
  const output: string[] = [];
  const handlers = new Map<string, () => void>();
  const served: Array<{ config: unknown; flags: string[]; stops: number }> = [];
  const base: NonNullable<Parameters<typeof main>[1]> = {
    serve: async (config, flags) => {
      const entry = { config, flags, stops: 0 };

      served.push(entry);

      return {
        done: Promise.resolve(),
        stop: async () => {
          entry.stops += 1;
        },
      };
    },
    write   : (text) => void output.push(text),
    onSignal: (signal, handler) => void handlers.set(signal, handler),
    ...overrides,
  };

  return { output, handlers, served, run: (argv: string[]) => main(argv, base) };
}

function fakeRunning(outcome: DaemonOutcome): RunningDaemon & { stops: number } {
  const state = { stops: 0 };

  return Object.assign(state, {
    done: Promise.resolve(outcome),
    stop: async () => {
      state.stops += 1;

      return outcome;
    },
  });
}

describe("usage", () => {
  it("fails for an unknown command", async () => {
    const { output, run, served } = harness();

    expect(await run(["install"])).toBe(2);
    expect(output.join("")).toContain("Usage:");
    expect(served).toEqual([]);
  });

  it.each(["--help", "-h"])("succeeds for %s without starting anything", async (flag) => {
    const { output, run, served } = harness();

    expect(await run([flag])).toBe(0);
    expect(output.join("")).toContain("Usage:");
    expect(served).toEqual([]);
  });
});

describe("MCP server mode", () => {
  it("serves on stdio when there is no command", async () => {
    const { run, served } = harness();

    expect(await run([])).toBe(0);
    expect(served).toHaveLength(1);
    expect(served[0]?.flags).toEqual([]);
  });

  it("serves when only flags are given and hands the flags on for the daemon", async () => {
    const { run, served } = harness();

    expect(await run(["--mode", "managed", "--headless"])).toBe(0);
    expect(served[0]?.flags).toEqual(["--mode", "managed", "--headless"]);
    expect(served[0]?.config).toMatchObject({ mode: "managed", headless: true });
  });

  it("stops the MCP server on SIGINT, SIGTERM and SIGHUP", async () => {
    const { handlers, run, served } = harness();

    await run([]);
    expect([...handlers.keys()].sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
    handlers.get("SIGINT")?.();
    handlers.get("SIGTERM")?.();
    handlers.get("SIGHUP")?.();
    expect(served[0]?.stops).toBe(3);
  });

  it("waits until the server has finished before it returns", async () => {
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const { run } = harness({ serve: async () => ({ done, stop: async () => undefined }) });
    let returned = false;
    const pending = run([]).then((code) => {
      returned = true;

      return code;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(returned).toBe(false);
    finish();
    expect(await pending).toBe(0);
  });

  it("refuses a mistyped flag and does not serve", async () => {
    const { output, run, served } = harness();

    expect(await run(["--readonly"])).toBe(2);
    expect(output.join("")).toContain("Unknown option '--readonly'");
    expect(served).toEqual([]);
  });

  it("reports a server that cannot start with exit code 1", async () => {
    const { output, run } = harness({
      serve: async () => {
        throw new Error("transport failed");
      },
    });

    expect(await run([])).toBe(1);
    expect(output.join("")).toContain("transport failed");
  });
});

describe("daemon command", () => {
  it("passes the flags after the command to the config loader", async () => {
    const load = vi.fn(() => ({ marker: true }) as never);
    const { run } = harness({ load, run: async () => fakeRunning({ reason: "idle" }) });

    await run(["daemon", "--mode", "managed", "--headless"]);
    expect(load).toHaveBeenCalledWith({ argv: ["--mode", "managed", "--headless"] });
  });

  it("reports an invalid configuration with the usage and exits with 2", async () => {
    const { output, run } = harness({
      load: () => {
        throw new ConfigError("invalid configuration: mode: bad");
      },
      run: async () => {
        throw new Error("must not start");
      },
    });

    expect(await run(["daemon"])).toBe(2);
    expect(output.join("")).toContain("invalid configuration: mode: bad");
    expect(output.join("")).toContain("Usage:");
  });

  it("refuses a mistyped flag with the real loader and does not start", async () => {
    const run = vi.fn();
    const output: string[] = [];
    const code = await main(["daemon", "--readonly"], {
      run,
      write   : (text) => void output.push(text),
      onSignal: () => undefined,
    });

    expect(code).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(output.join("")).toContain("Unknown option '--readonly'");
  });

  it("treats an already running daemon as success", async () => {
    const { output, run } = harness({
      load: () => ({}) as never,
      run : async () => {
        throw new AlreadyRunningError("/tmp/x.sock");
      },
    });

    expect(await run(["daemon"])).toBe(0);
    expect(output.join("")).toContain("already running");
  });

  it("fails with 1 when the daemon cannot start", async () => {
    const { output, run } = harness({
      load: () => ({}) as never,
      run : async () => {
        throw new Error("socket path is too long");
      },
    });

    expect(await run(["daemon"])).toBe(1);
    expect(output.join("")).toContain("socket path is too long");
  });

  it.each(["requested", "idle", "browser_disconnected"] as const)(
    "exits with 0 after a %s stop",
    async (reason) => {
      const { run } = harness({
        load: () => ({}) as never,
        run : async () => fakeRunning({ reason }),
      });

      expect(await run(["daemon"])).toBe(0);
    },
  );

  it("exits with 1 and prints the error when the daemon failed", async () => {
    const { output, run } = harness({
      load: () => ({}) as never,
      run : async () => fakeRunning({ reason: "failed", error: new Error("browser refused") }),
    });

    expect(await run(["daemon"])).toBe(1);
    expect(output.join("")).toContain("browser refused");
  });

  it("stops the daemon on SIGINT, SIGTERM and SIGHUP", async () => {
    const running = fakeRunning({ reason: "requested" });
    const { handlers, run } = harness({ load: () => ({}) as never, run: async () => running });

    await run(["daemon"]);
    expect([...handlers.keys()].sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
    handlers.get("SIGINT")?.();
    handlers.get("SIGTERM")?.();
    handlers.get("SIGHUP")?.();
    expect(running.stops).toBe(3);
  });
});
