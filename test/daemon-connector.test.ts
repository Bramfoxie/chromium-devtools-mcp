import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachEndpoint, ManagedBrowser } from "../src/browser/index.js";
import type { CdpClient } from "../src/cdp/index.js";
import type { Config } from "../src/config/index.js";
import { endpointUnreachableMessage } from "../src/browser/index.js";
import { approvalMessage, type ConnectorDeps, createConnector } from "../src/daemon/runner.js";

const config: Config = {
    browser   : "chrome",
    mode      : "managed",
    headless  : true,
    profileDir: "/data/profile",
    debugPort : 9222,
    allowFocus: false,
    isolated  : false,
    safety    : {
        readOnly            : false,
        allowedDomains      : [],
        deniedDomains       : [],
        allowPrivateNetworks: true,
        confirmDangerous    : false,
        uploadDirs          : [],
    },
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
        readonly url              : string,
        private readonly userAgent: string | null = HEADLESS_AGENT,
        private readonly targets  : Array<{ type: string; targetId: string }> = [],
    ) {}

    async send(method: string, params?: unknown): Promise<unknown> {
        this.sent.push(params === undefined ? method : `${method} ${JSON.stringify(params)}`);

        if (method === "Target.getTargets") return { targetInfos: this.targets };

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
        release     : () => void order.push("browser released"),
    };
    const deps: ConnectorDeps = {
        launch: vi.fn(async () => {
            order.push("launched");

            return launched;
        }),
        attach     : vi.fn(async () => running),
        findRunning: vi.fn(async () => undefined),
        sleep      : async () => undefined,
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

    it("logs before launching a browser so a slow start is not mistaken for a hang", async () => {
        const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const { connector } = setup();

        await connector(config, hooks, signal);
        expect(write.mock.calls.map(([text]) => String(text)).join("")).toContain(
            "Starting a managed browser on /data/profile.",
        );
    });

    it("reuses a browser left on the profile in the same headless mode and never closes it", async () => {
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const { deps, clients, connector } = setup({ findRunning: vi.fn(async () => running) });
        const handle = await connector(config, hooks, signal);

        expect(deps.launch).not.toHaveBeenCalled();
        expect(clients.map((client) => client.url)).toEqual([running.webSocketUrl]);
        await handle.stop();
        expect(clients[0]?.sent).toEqual(["Browser.getVersion", "Target.getTargets"]);
        expect(clients[0]?.closed).toBe(true);
    });

    it("closes the pages a dead daemon left in a headless browser and nothing else", async () => {
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const targets = [
            { type: "page", targetId: "p1" },
            { type: "service_worker", targetId: "w1" },
            { type: "page", targetId: "p2" },
        ];
        const { connector, clients } = setup({
            findRunning: vi.fn(async () => running),
            connect    : async (url) => {
                const client = new FakeClient(url, HEADLESS_AGENT, targets);

                clients.push(client);

                return client as unknown as CdpClient;
            },
        });

        await connector(config, hooks, signal);
        expect(clients[0]?.sent).toEqual([
            "Browser.getVersion",
            "Target.getTargets",
            'Target.closeTarget {"targetId":"p1"}',
            'Target.closeTarget {"targetId":"p2"}',
        ]);
    });

    it("leaves the pages of a browser with a window alone", async () => {
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const { clients, connector } = setup(
            { findRunning: vi.fn(async () => running) },
            WINDOW_AGENT,
        );

        await connector({ ...config, headless: false }, hooks, signal);
        expect(clients[0]?.sent).toEqual(["Browser.getVersion"]);
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
        const { deps, clients, connector } = setup(
            { findRunning: vi.fn(async () => running) },
            null,
        );

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

describe("releasing a managed browser", () => {
    it("lets a browser with a window outlive the daemon", async () => {
        const { clients, order, connector } = setup();
        const handle = await connector({ ...config, headless: false }, hooks, signal);

        await handle.release?.();
        expect(clients[0]?.closed).toBe(true);
        expect(order).toEqual(["launched", "browser released"]);
    });

    it("always stops a headless browser", async () => {
        const { connector } = setup();
        const handle = await connector({ ...config, headless: true }, hooks, signal);

        expect(handle.release).toBeUndefined();
    });
});

describe("attach mode", () => {
    const attachConfig: Config = { ...config, mode: "attach" };

    it("asks the user to allow the connection when the endpoint came from the port file", async () => {
        const { deps, clients, connector } = setup();
        const handle = await connector(attachConfig, hooks, signal);

        expect(deps.attach).toHaveBeenCalledWith(
            attachConfig,
            { onWaiting: hooks.onWaiting },
            signal,
        );
        expect(hooks.onWaiting).toHaveBeenCalledWith(approvalMessage());
        expect(clients[0]?.url).toBe(running.webSocketUrl);
        await handle.stop();
        expect(clients[0]?.closed).toBe(true);
        expect(clients[0]?.sent).toEqual([]);
    });

    it("keeps waiting when the browser endpoint does not accept the connection yet", async () => {
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const timeouts: Array<number | undefined> = [];
        let attempts = 0;
        const { deps, connector } = setup({
            connect: async (url, handshakeTimeoutMs) => {
                timeouts.push(handshakeTimeoutMs);
                attempts += 1;
                if (attempts < 3) throw new Error("not approved yet");

                return new FakeClient(url) as unknown as CdpClient;
            },
        });

        await connector(attachConfig, hooks, signal);
        expect(attempts).toBe(3);
        expect(deps.attach).toHaveBeenCalledTimes(3);
        expect(timeouts.every((ms) => ms !== undefined && ms >= 60_000)).toBe(true);
    });

    it("gives up retrying once the daemon is stopping", async () => {
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const controller = new AbortController();
        const { connector } = setup({
            connect: async () => {
                controller.abort();

                throw new Error("refused");
            },
        });

        await expect(connector(attachConfig, hooks, controller.signal)).rejects.toThrow("refused");
    });

    it("does not ask for approval on the debug port", async () => {
        const { connector } = setup({
            attach: vi.fn(async () => ({ ...running, source: "debug-port" as const })),
        });

        await connector(attachConfig, hooks, signal);
        expect(hooks.onWaiting).not.toHaveBeenCalled();
    });
});

describe("attach mode with an explicit endpoint", () => {
    const endpoint = "ws://127.0.0.1:9444/devtools/browser/given";
    const explicitConfig: Config = { ...config, mode: "attach", wsEndpoint: endpoint };

    it("connects to the endpoint without looking for a browser", async () => {
        const { deps, clients, connector } = setup();

        await connector(explicitConfig, hooks, signal);

        expect(deps.attach).not.toHaveBeenCalled();
        expect(deps.findRunning).not.toHaveBeenCalled();
        expect(clients.map((client) => client.url)).toEqual([endpoint]);
        expect(hooks.onWaiting).not.toHaveBeenCalled();
    });

    it("tells the clients once that the endpoint is unreachable and keeps retrying", async () => {
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        let attempts = 0;
        const { clients, connector } = setup({
            connect: async (url) => {
                attempts += 1;
                if (attempts < 3) throw new Error("refused");

                const client = new FakeClient(url);

                clients.push(client);

                return client as unknown as CdpClient;
            },
        });

        await connector(explicitConfig, hooks, signal);

        expect(attempts).toBe(3);
        expect(hooks.onWaiting).toHaveBeenCalledTimes(1);
        expect(hooks.onWaiting).toHaveBeenCalledWith(endpointUnreachableMessage());
        expect(hooks.onWaiting.mock.calls[0]?.[0]).not.toContain("given");
    });
});
