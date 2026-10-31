import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { spawn as nodeSpawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonError } from "../src/daemon/index.js";
import { spawnDaemonProcess } from "../src/mcp/index.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempLog(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-spawn-"));

  dirs.push(dir);

  return path.join(dir, "state", "daemon.log");
}

class FakeChild extends EventEmitter {
  unrefs = 0;
  unref() {
    this.unrefs += 1;
  }
}

function fakeSpawn() {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const child = new FakeChild();
  const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });

    return child;
  }) as unknown as typeof nodeSpawn;

  return { calls, child, spawn };
}

describe("spawnDaemonProcess", () => {
  it("starts a detached daemon with the flags and writes its output to the log", async () => {
    const logFile = await tempLog();
    const { calls, child, spawn } = fakeSpawn();

    await spawnDaemonProcess({
      execPath: "/usr/bin/node",
      script  : "/app/dist/cli.js",
      flags   : ["--mode", "managed"],
      logFile,
      spawn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("/usr/bin/node");
    expect(calls[0]?.args).toEqual(["/app/dist/cli.js", "daemon", "--mode", "managed"]);
    expect(calls[0]?.options).toMatchObject({ detached: true, windowsHide: true });
    const stdio = calls[0]?.options.stdio as unknown[];

    expect(stdio[0]).toBe("ignore");
    expect(typeof stdio[1]).toBe("number");
    expect(stdio[2]).toBe(stdio[1]);
    expect(child.unrefs).toBe(1);
  });

  it("creates the log directory and keeps the log private", async () => {
    const logFile = await tempLog();
    const { spawn } = fakeSpawn();

    await spawnDaemonProcess({ execPath: "n", script: "s", flags: [], logFile, spawn });
    const info = await stat(logFile);

    expect(info.isFile()).toBe(true);
    if (process.platform !== "win32") expect(info.mode & 0o077).toBe(0);
  });

  it("appends to a small log and truncates one above one mebibyte", async () => {
    const logFile = await tempLog();
    const { spawn } = fakeSpawn();

    await spawnDaemonProcess({ execPath: "n", script: "s", flags: [], logFile, spawn });
    await writeFile(logFile, "old output\n");
    await spawnDaemonProcess({ execPath: "n", script: "s", flags: [], logFile, spawn });
    expect(await readFile(logFile, "utf8")).toBe("old output\n");
    await writeFile(logFile, "x".repeat(1024 * 1024 + 1));
    await spawnDaemonProcess({ execPath: "n", script: "s", flags: [], logFile, spawn });
    expect((await stat(logFile)).size).toBe(0);
  });

  it("reports the exit of the process and also a failure to start it", async () => {
    const logFile = await tempLog();
    const first = fakeSpawn();
    const started = await spawnDaemonProcess({
      execPath: "n",
      script  : "s",
      flags   : [],
      logFile,
      spawn   : first.spawn,
    });
    let exited = false;

    void started.exited.then(() => {
      exited = true;
    });
    await Promise.resolve();
    expect(exited).toBe(false);
    first.child.emit("exit", 0);
    await started.exited;
    const second = fakeSpawn();
    const failed = await spawnDaemonProcess({
      execPath: "n",
      script  : "s",
      flags   : [],
      logFile,
      spawn   : second.spawn,
    });

    second.child.emit("error", new Error("spawn ENOENT"));
    await expect(failed.exited).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "refuses a log file that is a symbolic link",
    async () => {
      const logFile = await tempLog();
      const { spawn } = fakeSpawn();

      await spawnDaemonProcess({ execPath: "n", script: "s", flags: [], logFile, spawn });
      const target = path.join(path.dirname(logFile), "elsewhere.txt");

      await writeFile(target, "keep");
      await rm(logFile);
      await symlink(target, logFile);
      await expect(
        spawnDaemonProcess({ execPath: "n", script: "s", flags: [], logFile, spawn }),
      ).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("keep");
    },
  );

  it.skipIf(process.platform === "win32")("keeps the data directory private", async () => {
    const logFile = await tempLog();
    const { spawn } = fakeSpawn();

    await spawnDaemonProcess({ execPath: "n", script: "s", flags: [], logFile, spawn });
    expect((await stat(path.dirname(logFile))).mode & 0o077).toBe(0);
  });

  it("lets a spawn failure through", async () => {
    const logFile = await tempLog();
    const spawn = (() => {
      throw new Error("spawn exploded");
    }) as unknown as typeof nodeSpawn;

    await expect(
      spawnDaemonProcess({ execPath: "n", script: "s", flags: [], logFile, spawn }),
    ).rejects.toThrow("spawn exploded");
  });

  it("wraps an unreadable log location in a DaemonError that names the file", async () => {
    const logFile = await tempLog();
    const { spawn } = fakeSpawn();

    await mkdir(path.dirname(logFile), { recursive: true });
    await mkdir(path.join(path.dirname(logFile), "daemon.log"));
    const failure = await spawnDaemonProcess({
      execPath: "n",
      script  : "s",
      flags   : [],
      logFile,
      spawn,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonError);
    expect((failure as Error).message).toContain("daemon.log");
  });
});
