import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachEndpoint, ManagedBrowser } from "../src/browser/index.js";
import type { CdpClient } from "../src/cdp/index.js";
import type { Config } from "../src/config/index.js";
import { approvalMessage, type ConnectorDeps, createConnector } from "../src/daemon/index.js";

const config: Config = {
  browser   : "chrome",
  mode      : "managed",
  headless  : true,
  profileDir: "/data/profile",
  debugPort : 9222,
  allowFocus: false,
  safety    : { readOnly: false, allowedDomains: [], confirmDangerous: false },
};

const running: AttachEndpoint = {
  port        : 9333,
  webSocketUrl: "ws://127.0.0.1:9333/devtools/browser/left",
  source      : "port-file",
};

const HEADLESS_AGENT = "Mozilla/5.0 (X11; Linux aarch64) HeadlessChrome/156.0.0.0 Safari/537.36";
const WINDOW_AGENT = "Mozilla/5.0 (X11; Linux aarch64) Chrome/156.0.0.0 Safari/537.36";

class FakeClient {
  readonly sent: string[] = [];
  closed = false;

  constructor(
    readonly url: string,
    private readonly userAgent: string | null = HEADLESS_AGENT,
  ) {}

  async send(method: string): Promise<unknown> {
    this.sent.push(method);

    if (method !== "Browser.getVersion") return {};

    if (this.userAgent === null) throw new Error("no version");

    return { userAgent: this.userAgent };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function setup(overrides: Partial<ConnectorDeps> = {}, agent: string | null = HEADLESS_AGENT) {
  const clients: FakeClient[] = [];
  const order: string[] = [];
  const launched: ManagedBrowser = {
    port        : 9222,
    webSocketUrl: "ws://127.0.0.1:9222/devtools/browser/new",
    stop        : async () => void order.push("browser stopped"),
  };
  const deps: ConnectorDeps = {
    launch: vi.fn(async () => {
      order.push("launched");

      return launched;
    }),
    attach     : vi.fn(async () => running),
    findRunning: vi.fn(async () => undefined),
    connect    : async (url) => {
      const client = new FakeClient(url, agent);

      clients.push(client);

      return client as unknown as CdpClient;
    },
    ...overrides,
  };

  return { deps, clients, order, connector: createConnector(deps) };
}

const hooks = { onWaiting: vi.fn() };
const signal = new AbortController().signal;

afterEach(() => {
  vi.restoreAllMocks();
  hooks.onWaiting.mockReset();
});

describe("managed mode", () => {
  it("launches a browser when none runs on the profile", async () => {
    const { deps, clients, order, connector } = setup();
    const handle = await connector(config, hooks, signal);

    expect(deps.findRunning).toHaveBeenCalledWith("/data/profile", 9222);
    expect(clients.map((client) => client.url)).toEqual([
      "ws://127.0.0.1:9222/devtools/browser/new",
    ]);
    await handle.stop();
    expect(clients[0]?.closed).toBe(true);
    expect(order).toEqual(["launched", "browser stopped"]);
  });

  it("stops the launched browser when the CDP connection fails", async () => {
    const { order, connector } = setup({
      connect: async () => {
        throw new Error("refused");
      },
    });

    await expect(connector(config, hooks, signal)).rejects.toThrow("refused");
    expect(order).toEqual(["launched", "browser stopped"]);
  });

  it("reuses a browser left on the profile in the same headless mode and never closes it", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { deps, clients, connector } = setup({ findRunning: vi.fn(async () => running) });
    const handle = await connector(config, hooks, signal);

    expect(deps.launch).not.toHaveBeenCalled();
    expect(clients.map((client) => client.url)).toEqual([running.webSocketUrl]);
    await handle.stop();
    expect(clients[0]?.sent).toEqual(["Browser.getVersion"]);
    expect(clients[0]?.closed).toBe(true);
  });

  it("refuses a browser left in the other headless mode and leaves it running", async () => {
    const { deps, clients, connector } = setup(
      { findRunning: vi.fn(async () => running) },
      WINDOW_AGENT,
    );

    await expect(connector(config, hooks, signal)).rejects.toThrow(
      /with a window, but headless is true\. Close that browser or set headless to false/,
    );
    expect(clients[0]?.sent).toEqual(["Browser.getVersion"]);
    expect(clients[0]?.closed).toBe(true);
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it("neither adopts nor closes a browser whose mode cannot be read", async () => {
    const { deps, clients, connector } = setup({ findRunning: vi.fn(async () => running) }, null);

    await connector(config, hooks, signal);
    expect(clients[0]?.sent).toEqual(["Browser.getVersion"]);
    expect(clients[0]?.closed).toBe(true);
    expect(deps.launch).toHaveBeenCalledTimes(1);
  });

  it("launches when the browser left on the profile does not accept a connection", async () => {
    const urls: string[] = [];
    const { deps, connector } = setup({
      findRunning: vi.fn(async () => running),
      connect    : async (url) => {
        urls.push(url);
        if (url === running.webSocketUrl) throw new Error("refused");

        return new FakeClient(url) as unknown as CdpClient;
      },
    });

    await connector(config, hooks, signal);
    expect(deps.launch).toHaveBeenCalledTimes(1);
    expect(urls).toEqual([running.webSocketUrl, "ws://127.0.0.1:9222/devtools/browser/new"]);
  });
});

describe("attach mode", () => {
  const attachConfig: Config = { ...config, mode: "attach" };

  it("asks the user to allow the connection when the endpoint came from the port file", async () => {
    const { deps, clients, connector } = setup();
    const handle = await connector(attachConfig, hooks, signal);

    expect(deps.attach).toHaveBeenCalledWith(attachConfig, { onWaiting: hooks.onWaiting }, signal);
    expect(hooks.onWaiting).toHaveBeenCalledWith(approvalMessage());
    expect(clients[0]?.url).toBe(running.webSocketUrl);
    await handle.stop();
    expect(clients[0]?.closed).toBe(true);
    expect(clients[0]?.sent).toEqual([]);
  });

  it("does not ask for approval on the debug port", async () => {
    const { connector } = setup({
      attach: vi.fn(async () => ({ ...running, source: "debug-port" as const })),
    });

    await connector(attachConfig, hooks, signal);
    expect(hooks.onWaiting).not.toHaveBeenCalled();
  });
});
