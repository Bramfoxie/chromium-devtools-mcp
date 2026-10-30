import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttachError,
  attachBrowser,
  type AttachDeps,
  browserUserDataDir,
  parseActivePortFile,
  resolveAttachEndpoint,
  setupInstructions,
} from "../src/browser/index.js";
import { abortableSleep, fetchVersion, probePort, readIfExists } from "../src/browser/attach.js";

const mac = { platform: "darwin" as const, homedir: "/Users/u", env: {} };
const linux = { platform: "linux" as const, homedir: "/home/u", env: {} };
const windows = {
  platform: "win32" as const,
  homedir : "C:\\Users\\u",
  env     : { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
};

const config = { browser: "chrome" as const, debugPort: 9222 };
const portFile = "/Users/u/Library/Application Support/Google/Chrome/DevToolsActivePort";
const fileContent = "9333\n/devtools/browser/from-file\n";
const version = { webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/from-http" };

interface World {
  files?    : Record<string, string>;
  openPorts?: number[];
  versions? : Record<number, unknown>;
}

function deps(world: World = {}, overrides: Partial<AttachDeps> = {}) {
  const logs: string[] = [];
  const value: AttachDeps = {
    context       : mac,
    readFile      : async (file) => world.files?.[file],
    isPortOpen    : async (port) => world.openPorts?.includes(port) ?? false,
    fetchVersion  : async (port) => world.versions?.[port],
    sleep         : async () => undefined,
    log           : (message) => logs.push(message),
    onWaiting     : () => undefined,
    pollIntervalMs: 1,
    ...overrides,
  };

  return { value, logs };
}

describe("browserUserDataDir", () => {
  it("returns the default Chrome and Arc directories on macOS", () => {
    expect(browserUserDataDir("chrome", mac)).toBe(
      "/Users/u/Library/Application Support/Google/Chrome",
    );
    expect(browserUserDataDir("arc", mac)).toBe(
      "/Users/u/Library/Application Support/Arc/User Data",
    );
  });

  it("ignores empty XDG_CONFIG_HOME and LOCALAPPDATA", () => {
    expect(browserUserDataDir("chrome", { ...linux, env: { XDG_CONFIG_HOME: "" } })).toBe(
      "/home/u/.config/google-chrome",
    );
    expect(browserUserDataDir("chrome", { ...windows, env: { LOCALAPPDATA: "" } })).toBe(
      "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data",
    );
  });

  it("honors XDG_CONFIG_HOME on Linux", () => {
    expect(browserUserDataDir("chrome", linux)).toBe("/home/u/.config/google-chrome");
    expect(browserUserDataDir("chrome", { ...linux, env: { XDG_CONFIG_HOME: "/x" } })).toBe(
      "/x/google-chrome",
    );
  });

  it("uses LOCALAPPDATA on Windows and falls back to the home directory", () => {
    expect(browserUserDataDir("chrome", { ...windows, env: { LOCALAPPDATA: "D:\\Local" } })).toBe(
      "D:\\Local\\Google\\Chrome\\User Data",
    );
    expect(browserUserDataDir("chrome", { ...windows, env: {} })).toBe(
      "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data",
    );
  });

  it("has no Arc directory outside macOS", () => {
    expect(browserUserDataDir("arc", linux)).toBeUndefined();
    expect(browserUserDataDir("arc", windows)).toBeUndefined();
  });
});

describe("parseActivePortFile", () => {
  it("builds the endpoint from the port file", () => {
    expect(parseActivePortFile("9333\r\n/devtools/browser/x\r\n")).toEqual({
      port        : 9333,
      webSocketUrl: "ws://127.0.0.1:9333/devtools/browser/x",
    });
  });

  it.each(["", "9333", "0\n/devtools/browser/x", "70000\n/devtools/browser/x", "9333\n/other"])(
    "rejects %j",
    (content) => {
      expect(parseActivePortFile(content)).toBeUndefined();
    },
  );
});

describe("resolveAttachEndpoint", () => {
  it("prefers the port file when its port is open", async () => {
    const { value } = deps({
      files    : { [portFile]: fileContent },
      openPorts: [9333],
      versions : { 9222: version },
    });

    expect(await resolveAttachEndpoint(config, value)).toEqual({
      port        : 9333,
      webSocketUrl: "ws://127.0.0.1:9333/devtools/browser/from-file",
      source      : "port-file",
    });
  });

  it("ignores a stale port file and uses the configured debug port", async () => {
    const { value } = deps({ files: { [portFile]: fileContent }, versions: { 9222: version } });

    expect(await resolveAttachEndpoint(config, value)).toMatchObject({
      port  : 9222,
      source: "debug-port",
    });
  });

  it("uses the configured debug port when there is no port file", async () => {
    const { value } = deps({ versions: { 9222: version } });

    expect(await resolveAttachEndpoint(config, value)).toEqual({
      port        : 9222,
      webSocketUrl: version.webSocketDebuggerUrl,
      source      : "debug-port",
    });
  });

  it("builds the port file path with the injected platform separators", async () => {
    const file = "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data\\DevToolsActivePort";
    const { value } = deps(
      { files: { [file]: fileContent }, openPorts: [9333] },
      { context: windows },
    );

    expect(await resolveAttachEndpoint(config, value)).toMatchObject({ source: "port-file" });
  });

  it("falls through to the debug port when the port file cannot be read", async () => {
    const { value } = deps(
      { versions: { 9222: version } },
      {
        readFile: async () => {
          throw new Error("EACCES");
        },
      },
    );

    expect(await resolveAttachEndpoint(config, value)).toMatchObject({ source: "debug-port" });
  });

  it("returns undefined when nothing is reachable", async () => {
    expect(await resolveAttachEndpoint(config, deps().value)).toBeUndefined();
  });

  it.each([
    ["not an object", "oops"],
    ["no URL", {}],
    ["URL is not a string", { webSocketDebuggerUrl: 5 }],
    ["not a browser socket", { webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1" }],
    ["remote host", { webSocketDebuggerUrl: "ws://evil.example:9222/devtools/browser/x" }],
    ["different port", { webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/browser/x" }],
    ["implicit port 80", { webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/x" }],
    ["wrong scheme", { webSocketDebuggerUrl: "wss://127.0.0.1:9222/devtools/browser/x" }],
    ["unparseable URL", { webSocketDebuggerUrl: "::::" }],
  ])("rejects a version response with %s", async (_name, response) => {
    const { value } = deps({ versions: { 9222: response } });

    expect(await resolveAttachEndpoint(config, value)).toBeUndefined();
  });

  it("accepts a URL without an explicit port when the debug port is 80", async () => {
    const response = { webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/x" };
    const { value } = deps({ versions: { 80: response } });

    expect(await resolveAttachEndpoint({ ...config, debugPort: 80 }, value)).toMatchObject({
      port: 80,
    });
  });

  it("accepts IPv6 and localhost loopback URLs", async () => {
    for (const host of ["[::1]", "localhost"]) {
      const response = { webSocketDebuggerUrl: `ws://${host}:9222/devtools/browser/x` };
      const { value } = deps({ versions: { 9222: response } });

      expect(await resolveAttachEndpoint(config, value)).toMatchObject({ source: "debug-port" });
    }
  });

  it("skips the port file for a browser without a known directory", async () => {
    const { value } = deps({ versions: { 9222: version } }, { context: linux });

    expect(await resolveAttachEndpoint({ browser: "arc", debugPort: 9222 }, value)).toMatchObject({
      source: "debug-port",
    });
  });
});

describe("attachBrowser", () => {
  it("returns immediately and reports the chosen source and port", async () => {
    const { value, logs } = deps({ versions: { 9222: version } });

    await expect(attachBrowser(config, value)).resolves.toMatchObject({ source: "debug-port" });
    expect(logs).toEqual(["Attaching to chrome on port 9222 (debug-port)."]);
  });

  it("prints the instructions once and waits until remote debugging appears", async () => {
    let fetches = 0;
    let sleeps = 0;
    const { value, logs } = deps(
      {},
      {
        fetchVersion: async () => (++fetches === 3 ? version : undefined),
        sleep       : async () => {
          sleeps += 1;
        },
      },
    );
    const endpoint = await attachBrowser(config, value);

    expect(endpoint.source).toBe("debug-port");
    expect(fetches).toBe(3);
    expect(sleeps).toBe(2);
    const instructions = logs.filter((line) => line.includes("Cannot attach"));

    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toContain("chrome://inspect/#remote-debugging");
    expect(instructions[0]).toContain("--remote-debugging-port=9222");
    expect(instructions[0]).toContain("non-default directory");
  });

  it("hands the instructions to onWaiting exactly once", async () => {
    let fetches = 0;
    const waiting: string[] = [];
    const { value } = deps(
      {},
      {
        fetchVersion: async () => (++fetches === 4 ? version : undefined),
        onWaiting   : (instructions) => waiting.push(instructions),
      },
    );

    await attachBrowser(config, value);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toContain("chrome://inspect/#remote-debugging");
  });

  it("does not call onWaiting when the browser is already available", async () => {
    const waiting: string[] = [];
    const { value } = deps(
      { versions: { 9222: version } },
      { onWaiting: (text) => waiting.push(text) },
    );

    await attachBrowser(config, value);
    expect(waiting).toEqual([]);
  });

  it("rejects with AttachError when cancelled while waiting", async () => {
    const controller = new AbortController();
    let fetches = 0;
    let sleeps = 0;
    const { value, logs } = deps(
      {},
      {
        fetchVersion: async () => {
          if (++fetches === 2) controller.abort();

          return undefined;
        },
        sleep: async () => {
          sleeps += 1;
        },
      },
    );
    const failure = await attachBrowser(config, value, controller.signal).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AttachError);
    expect(fetches).toBe(2);
    expect(sleeps).toBe(2);
    expect(logs).toHaveLength(1);
  });

  it("passes the abort signal to the probes and the sleep", async () => {
    const controller = new AbortController();
    const seen = {
      isPortOpen  : [] as unknown[],
      fetchVersion: [] as unknown[],
      sleep       : [] as unknown[],
    };
    let fetches = 0;
    const { value } = deps(
      { files: { [portFile]: fileContent } },
      {
        isPortOpen: async (_port, signal) => {
          seen.isPortOpen.push(signal);

          return false;
        },
        fetchVersion: async (_port, signal) => {
          seen.fetchVersion.push(signal);
          if (++fetches === 3) controller.abort();

          return undefined;
        },
        sleep: async (_ms, signal) => {
          seen.sleep.push(signal);
        },
      },
    );

    await attachBrowser(config, value, controller.signal).catch(() => undefined);

    for (const calls of Object.values(seen)) {
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((signal) => signal === controller.signal)).toBe(true);
    }
  });

  it("does not poll when already cancelled", async () => {
    const controller = new AbortController();

    controller.abort();
    const { value, logs } = deps({ versions: { 9222: version } });

    await expect(attachBrowser(config, value, controller.signal)).rejects.toBeInstanceOf(
      AttachError,
    );
    expect(logs).toEqual([]);
  });
});

describe("setupInstructions", () => {
  it("offers the inspect toggle with the version requirement for Chrome", () => {
    const text = setupInstructions(config);

    expect(text).toContain("Chrome 144 or newer");
    expect(text).toContain("chrome://inspect/#remote-debugging");
    expect(text).toContain("Option 2");
  });

  it("offers only the port flag for Arc", () => {
    const text = setupInstructions({ browser: "arc", debugPort: 9222 });

    expect(text).toContain("Arc");
    expect(text).not.toContain("chrome://inspect");
    expect(text).toContain("--remote-debugging-port=9222");
  });

  it("contains only plain ASCII", () => {
    for (const browser of ["chrome", "arc"] as const) {
      expect(setupInstructions({ browser, debugPort: 9222 })).toMatch(/^[\x20-\x7E\n]+$/);
    }
  });
});

describe("default I/O", () => {
  const closers: Array<() => void> = [];

  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  async function serve(handler: http.RequestListener) {
    const server = http.createServer(handler);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => server.close());

    return (server.address() as AddressInfo).port;
  }

  it("fetches and parses /json/version", async () => {
    const urls: Array<string | undefined> = [];
    const port = await serve((request, response) => {
      urls.push(request.url);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(version));
    });

    expect(await fetchVersion(port)).toEqual(version);
    expect(urls).toEqual(["/json/version"]);
  });

  it("does not follow redirects", async () => {
    const target = await serve((_request, response) => response.end(JSON.stringify(version)));
    const port = await serve((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", `http://127.0.0.1:${target}/json/version`);
      response.end();
    });

    expect(await fetchVersion(port)).toBeUndefined();
  });

  it("gives up on a server that never answers", async () => {
    const port = await serve(() => undefined);
    const started = Date.now();

    expect(await fetchVersion(port, undefined, 50)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("rejects oversized responses", async () => {
    const big = JSON.stringify({ filler: "x".repeat(100 * 1024) });
    const sized = await serve((_request, response) => response.end(big));
    const chunked = await serve((_request, response) => {
      response.write(big.slice(0, 50 * 1024));
      response.end(big.slice(50 * 1024));
    });

    expect(await fetchVersion(sized)).toBeUndefined();
    expect(await fetchVersion(chunked)).toBeUndefined();
  });

  it("stops waiting for an answer when the signal aborts", async () => {
    const port = await serve(() => undefined);
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 30);
    const started = Date.now();

    expect(await fetchVersion(port, controller.signal)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(900);
  });

  it("returns undefined for non-JSON, error status and closed ports", async () => {
    const html = await serve((_request, response) => response.end("<html>"));
    const failing = await serve((_request, response) => {
      response.statusCode = 500;
      response.end("{}");
    });

    expect(await fetchVersion(html)).toBeUndefined();
    expect(await fetchVersion(failing)).toBeUndefined();
    const server = http.createServer();

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const closed = (server.address() as AddressInfo).port;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await fetchVersion(closed)).toBeUndefined();
  });

  it("probes whether a port accepts connections", async () => {
    const server = net.createServer((socket) => socket.destroy());

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    expect(await probePort(port)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probePort(port)).toBe(false);
  });

  it("probePort resolves false immediately for an aborted signal", async () => {
    const controller = new AbortController();

    controller.abort();
    expect(await probePort(1, controller.signal)).toBe(false);
  });

  it("abortableSleep ends early on abort and waits otherwise", async () => {
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 20);
    const started = Date.now();

    await abortableSleep(5000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1000);
    const waited = Date.now();

    await abortableSleep(40);
    expect(Date.now() - waited).toBeGreaterThanOrEqual(30);
  });

  it("reads an existing file and returns undefined for a missing one", async () => {
    expect(await readIfExists("/definitely/not/here")).toBeUndefined();
    expect(await readIfExists(fileURLToPath(import.meta.url))).toContain("default I/O");
  });
});
