import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DaemonNotRunningError,
  daemonIdentity,
  type DaemonLayout,
} from "../src/daemon/index.js";
import {
  type DaemonLink,
  createDaemonLink,
  createMcpServer,
  daemonLogFile,
  daemonScriptPath,
  packageVersion,
  readPackageVersion,
  runMcpServer,
} from "../src/mcp/index.js";
import { managedConfig } from "./helpers/daemon-env.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("packageVersion", () => {
  it("reads the version of package.json", () => {
    const expected = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string })
      .version;

    expect(packageVersion()).toBe(expected);
  });

  it("reads the version from the given file and names it when missing", () => {
    expect(readPackageVersion("/pkg/package.json", () => '{"version": "3.2.1"}')).toBe("3.2.1");
    expect(() => readPackageVersion("/pkg/package.json", () => "{}")).toThrow(
      /\/pkg\/package\.json has no version/,
    );
  });
});

describe("daemonScriptPath", () => {
  it("points at cli.js next to the server module", () => {
    const dist = path.join(os.tmpdir(), "app", "dist");
    const script = daemonScriptPath(pathToFileURL(path.join(dist, "mcp", "server.js")).href);

    expect(script).toBe(path.join(dist, "cli.js"));
  });
});

describe("createDaemonLink", () => {
  const layout = (platform: NodeJS.Platform, tokenFile: string): DaemonLayout => ({
    tokenFile,
    platform,
    uid       : undefined,
    socketPath: () => "",
    instance  : () => ({ socketPath: "", runtimeDir: undefined, platform, uid: undefined }),
  });

  it("passes the identity to the connector and the flags, paths and layout to the spawner", async () => {
    const connects: unknown[] = [];
    const spawns: unknown[] = [];
    const config = { ...managedConfig, browser: "chrome" as const };
    const link = createDaemonLink(config, ["--mode", "managed"], {
      layout  : layout("linux", "/home/u/.local/share/chromium-devtools-mcp/daemon.token"),
      execPath: "/usr/bin/node",
      script  : "/pkg/dist/cli.js",
      connect : async (expect) => {
        connects.push(expect);

        throw new DaemonNotRunningError();
      },
      spawn: async (options) => {
        spawns.push(options);

        throw new Error("no spawn");
      },
      now  : () => 0,
      sleep: async () => undefined,
    });

    await expect(link.request("x")).rejects.toThrow("no spawn");
    expect(connects).toEqual([daemonIdentity(config)]);
    expect(spawns).toEqual([
      {
        execPath: "/usr/bin/node",
        script  : "/pkg/dist/cli.js",
        flags   : ["--mode", "managed"],
        logFile : "/home/u/.local/share/chromium-devtools-mcp/daemon.log",
        platform: "linux",
        uid     : undefined,
      },
    ]);
  });
});

describe("createMcpServer", () => {
  it("completes the MCP handshake and reports its name and version", async () => {
    const server = createMcpServer("9.8.7");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    expect(client.getServerVersion()).toMatchObject({
      name   : "chromium-devtools-mcp",
      version: "9.8.7",
    });
    await client.close();
    await server.close();
  });
});

describe("daemonLogFile", () => {
  const layout = (platform: NodeJS.Platform, tokenFile: string): DaemonLayout => ({
    tokenFile,
    platform,
    uid       : undefined,
    socketPath: () => "",
    instance  : () => ({ socketPath: "", runtimeDir: undefined, platform, uid: undefined }),
  });

  it("puts the log next to the token with the platform separators", () => {
    expect(
      daemonLogFile(layout("linux", "/home/u/.local/share/chromium-devtools-mcp/daemon.token")),
    ).toBe("/home/u/.local/share/chromium-devtools-mcp/daemon.log");
    expect(
      daemonLogFile(
        layout("win32", "C:\\Users\\u\\AppData\\Local\\chromium-devtools-mcp\\daemon.token"),
      ),
    ).toBe("C:\\Users\\u\\AppData\\Local\\chromium-devtools-mcp\\daemon.log");
  });
});

describe("runMcpServer", () => {
  function setup() {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const link = { close: vi.fn(async () => undefined) };
    const lines: string[] = [];
    let pending = "";

    stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      const parts = pending.split("\n");

      pending = parts.pop() ?? "";
      lines.push(...parts);
    });
    const start = () =>
      runMcpServer(managedConfig, [], {
        link   : link as unknown as DaemonLink,
        stdin,
        stdout,
        version: "1.2.3",
      });
    const initialize = () =>
      stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id     : 1,
          method : "initialize",
          params : {
            protocolVersion: "2025-03-26",
            capabilities   : {},
            clientInfo     : { name: "t", version: "1" },
          },
        })}\n`,
      );

    return { stdin, stdout, link, lines, start, initialize };
  }

  it("answers the handshake on stdout and writes nothing else there", async () => {
    const { lines, start, initialize } = setup();
    const running = await start();

    initialize();
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    const reply = JSON.parse(lines[0] ?? "") as { id: number; result: { serverInfo: unknown } };

    expect(reply.id).toBe(1);
    expect(reply.result.serverInfo).toMatchObject({
      name   : "chromium-devtools-mcp",
      version: "1.2.3",
    });
    await running.stop();
    expect(lines).toHaveLength(1);
  });

  it("finishes and closes the daemon link when the client closes stdin", async () => {
    const { stdin, link, start, initialize } = setup();
    const running = await start();

    initialize();
    stdin.end();
    await running.done;
    expect(link.close).toHaveBeenCalledTimes(1);
  });

  it("finishes when the input stream is destroyed", async () => {
    const { stdin, link, start } = setup();
    const running = await start();

    stdin.destroy();
    await running.done;
    expect(link.close).toHaveBeenCalledTimes(1);
  });

  it("stops once however often it is asked and does not touch the link before", async () => {
    const { link, start } = setup();
    const running = await start();

    expect(link.close).not.toHaveBeenCalled();
    await Promise.all([running.stop(), running.stop()]);
    await running.stop();
    await running.done;
    expect(link.close).toHaveBeenCalledTimes(1);
  });

  it("still finishes when closing the link fails", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { link, start } = setup();

    link.close.mockRejectedValueOnce(new Error("link boom"));
    const running = await start();

    await running.stop();
    await running.done;
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "could not close the daemon link",
    );
  });

  it("stops when the output stream errors", async () => {
    const { stdout, link, start } = setup();
    const running = await start();

    stdout.emit("error", new Error("EPIPE"));
    await running.done;
    expect(link.close).toHaveBeenCalledTimes(1);
  });
});
