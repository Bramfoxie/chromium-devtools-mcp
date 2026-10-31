import { afterEach, describe, expect, it, vi } from "vitest";
import {
    acquireInstance,
    Daemon,
    ErrorCode,
    generateToken,
    IpcClient,
    MAX_LINE_BYTES,
    RpcError,
} from "../src/daemon/index.js";
import { CdpProtocolError } from "../src/cdp/index.js";
import { FakeBackend } from "./helpers/fake-backend.js";
import { createSocketHarness } from "./helpers/daemon-socket.js";

const harness = createSocketHarness();

afterEach(async () => {
    await harness.dispose();
    vi.restoreAllMocks();
});

async function start(allowFocus = false) {
    const options = await harness.options();
    const token = generateToken();
    const backend = new FakeBackend();
    const daemon = new Daemon({
        token,
        allowFocus,
        identity: { browser: "chrome", mode: "managed", debugPort: 9222, allowFocus: false },
    });

    daemon.setBackend(backend);
    const handle = await acquireInstance(options, daemon.accept);

    harness.track(async () => {
        await handle.release();
        await daemon.shutdown();
    });

    const connect = async (name = "client") => {
        const client = await IpcClient.connect({
            socketPath: options.socketPath,
            token,
            clientName: name,
        });

        harness.track(() => client.close());

        return client;
    };

    return { backend, daemon, connect };
}

async function failure(promise: Promise<unknown>): Promise<RpcError> {
    const error = await promise.then(
        () => undefined,
        (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(RpcError);

    return error as RpcError;
}

describe("session handling", () => {
    it("requires session.open before anything else", async () => {
        const { connect } = await start();
        const client = await connect();

        for (const method of ["tab.create", "tab.list", "cdp.send"]) {
            const error = await failure(client.request(method, { targetId: "t", method: "A.b" }));

            expect(error.code).toBe(ErrorCode.sessionRequired);
        }
    });

    it("opens one session per connection", async () => {
        const { connect } = await start();
        const client = await connect();

        await expect(client.request("session.open", { isolated: true })).resolves.toEqual({
            isolated: true,
        });
        expect((await failure(client.request("session.open"))).code).toBe(ErrorCode.badRequest);
    });

    it("opens a fresh session after the connection closed and reopened", async () => {
        const { backend, connect } = await start();
        const first = await connect();

        await first.request("session.open");
        await first.request("tab.create", { url: "https://a.example/" });
        await first.close();
        const second = await connect();

        await expect(second.request("session.open")).resolves.toEqual({ isolated: false });
        const owned = (await second.request("tab.list")) as { tabs: unknown[] };

        expect(owned.tabs).toEqual([]);
        expect(backend.log).toContain("closeTarget tab1");
    });

    it("answers unknown methods without touching the browser", async () => {
        const { backend, connect } = await start();
        const client = await connect();

        await client.request("session.open");

        for (const method of ["nope", "__proto__", "constructor", "toString"]) {
            expect((await failure(client.request(method))).code).toBe(ErrorCode.unknownMethod);
        }

        expect(backend.log).toEqual([]);
    });

    it("names the invalid fields but never echoes their values", async () => {
        const { connect } = await start();
        const client = await connect();

        await client.request("session.open");
        const error = await failure(client.request("tab.create", { url: 5, extra: "secret-value" }));

        expect(error.code).toBe(ErrorCode.badRequest);
        expect(error.message).toContain("tab.create");
        expect(error.message).not.toContain("secret-value");
        const wrongMethod = await failure(
            client.request("cdp.send", { targetId: "t", method: "not a method" }),
        );

        expect(wrongMethod.code).toBe(ErrorCode.badRequest);
    });
});

describe("parameter validation", () => {
    it.each([
        ["daemon.status", {}],
        ["session.open", {}],
        ["tab.create", {}],
        ["tab.list", {}],
        ["tab.claim", { targetId: "t" }],
        ["tab.close", { targetId: "t" }],
        ["cdp.send", { targetId: "t", method: "A.b" }],
        ["cdp.subscribe", { targetId: "t", event: "A.b" }],
        ["cdp.unsubscribe", { targetId: "t", event: "A.b" }],
    ])("%s rejects unknown fields", async (method, valid) => {
        const { connect } = await start();
        const client = await connect();

        if (method !== "session.open" && method !== "daemon.status") {
            await client.request("session.open");
        }

        const error = await failure(client.request(method, { ...valid, surprise: true }));

        expect(error.code).toBe(ErrorCode.badRequest);
        expect(error.message).toContain("surprise");
    });
});

describe("tabs through the daemon", () => {
    it.each([
        ["javascript:alert(1)"],
        ["data:text/html,hi"],
        ["file:///etc/passwd"],
        ["chrome://settings"],
        ["not a url"],
    ])("refuses to open %s", async (url) => {
        const { backend, connect } = await start();
        const client = await connect();

        await client.request("session.open");
        expect((await failure(client.request("tab.create", { url }))).code).toBe(
            ErrorCode.unsupportedUrl,
        );
        expect(backend.log).toEqual([]);
    });

    it("normalizes the URL before it reaches the browser", async () => {
        const { backend, connect } = await start();
        const client = await connect();

        await client.request("session.open");
        await client.request("tab.create", { url: "  HTTPS://Example.ORG/a b  " });
        expect(backend.log).toEqual(["createTarget tab1 default https://example.org/a%20b"]);
    });

    it("opens about:blank by default and http or https URLs on request", async () => {
        const { backend, connect } = await start();
        const client = await connect();

        await client.request("session.open");
        await client.request("tab.create");
        await client.request("tab.create", { url: "https://example.org/a" });
        await client.request("tab.create", { url: "http://example.org/b" });
        await client.request("tab.create", { url: "ABOUT:BLANK" });
        expect(backend.log).toEqual([
            "createTarget tab1 default about:blank",
            "createTarget tab2 default https://example.org/a",
            "createTarget tab3 default http://example.org/b",
            "createTarget tab4 default about:blank",
        ]);
    });

    it("keeps the tabs of two clients apart", async () => {
        const { connect } = await start();
        const alice = await connect("alice");
        const bob = await connect("bob");

        await alice.request("session.open");
        await bob.request("session.open", { isolated: true });
        const { targetId } = (await alice.request("tab.create")) as { targetId: string };

        expect((await failure(bob.request("cdp.send", { targetId, method: "Page.enable" }))).code).toBe(
            ErrorCode.notOwned,
        );
        expect((await failure(bob.request("tab.close", { targetId }))).code).toBe(ErrorCode.notOwned);
        expect(((await bob.request("tab.list")) as { tabs: unknown[] }).tabs).toEqual([]);
        await expect(
            alice.request("cdp.send", { targetId, method: "Page.enable" }),
        ).resolves.toMatchObject({ echoed: "Page.enable" });
    });

    it("lists, claims and closes tabs", async () => {
        const { backend, connect } = await start();
        const userTab = backend.seedTab("https://user.example/");
        const client = await connect();

        await client.request("session.open");
        const available = (await client.request("tab.list", { scope: "available" })) as {
            tabs: Array<{ targetId: string }>;
        };

        expect(available.tabs.map((tab) => tab.targetId)).toEqual([userTab]);
        await client.request("tab.claim", { targetId: userTab });
        const owned = (await client.request("tab.list")) as { tabs: Array<{ targetId: string }> };

        expect(owned.tabs.map((tab) => tab.targetId)).toEqual([userTab]);
        expect((await failure(client.request("tab.close", { targetId: userTab }))).code).toBe(
            ErrorCode.notCreated,
        );
        expect(backend.targets.has(userTab)).toBe(true);
        const { targetId } = (await client.request("tab.create")) as { targetId: string };

        await client.request("tab.close", { targetId });
        expect(backend.targets.has(targetId)).toBe(false);
    });
});

describe("commands and events", () => {
    it("sends CDP commands and returns their results", async () => {
        const { backend, connect } = await start();
        const client = await connect();

        await client.request("session.open");
        const { targetId } = (await client.request("tab.create")) as { targetId: string };

        await expect(
            client.request("cdp.send", {
                targetId,
                method   : "Page.navigate",
                params   : { url: "https://example.org/" },
                timeoutMs: 5000,
            }),
        ).resolves.toEqual({ echoed: "Page.navigate", target: targetId });
        expect(backend.sessions.get(targetId)?.sent[0]).toEqual({
            method   : "Page.navigate",
            params   : { url: "https://example.org/" },
            timeoutMs: 5000,
        });
    });

    it("refuses browser level and focus commands", async () => {
        const { connect } = await start(false);
        const client = await connect();

        await client.request("session.open");
        const { targetId } = (await client.request("tab.create")) as { targetId: string };

        for (const method of [
            "Target.createTarget",
            "Browser.close",
            "Page.bringToFront",
            "Security.disable",
        ]) {
            expect((await failure(client.request("cdp.send", { targetId, method }))).code).toBe(
                ErrorCode.forbiddenMethod,
            );
        }
    });

    it("returns CDP failures as typed errors instead of internal ones", async () => {
        const { backend, connect } = await start();
        const client = await connect();

        await client.request("session.open");
        const { targetId } = (await client.request("tab.create")) as { targetId: string };

        await client.request("cdp.send", { targetId, method: "Page.enable" });
        const session = backend.sessions.get(targetId);

        if (session) session.failure = new CdpProtocolError("Page.navigate", -32000, "Cannot navigate");

        const error = await failure(client.request("cdp.send", { targetId, method: "Page.reload" }));

        expect(error.code).toBe(ErrorCode.cdpError);
        expect(error.message).toContain("Cannot navigate");
    });

    it("answers an oversized CDP result with a dedicated error", async () => {
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const { backend, connect } = await start();
        const client = await connect();

        await client.request("session.open");
        const { targetId } = (await client.request("tab.create")) as { targetId: string };

        await client.request("cdp.send", { targetId, method: "Page.enable" });
        const session = backend.sessions.get(targetId);

        if (session) session.send = async () => ({ data: "x".repeat(MAX_LINE_BYTES + 10) });

        const error = await failure(
            client.request("cdp.send", { targetId, method: "Page.captureScreenshot" }),
        );

        expect(error.code).toBe(ErrorCode.resultTooLarge);
        await expect(client.request("tab.list")).resolves.toBeDefined();
    });

    it("allows Page.bringToFront when the daemon runs with allowFocus", async () => {
        const { connect } = await start(true);
        const client = await connect();

        await client.request("session.open");
        const { targetId } = (await client.request("tab.create")) as { targetId: string };

        await expect(
            client.request("cdp.send", { targetId, method: "Page.bringToFront" }),
        ).resolves.toBeDefined();
    });

    it("delivers subscribed events and tab.closed to the client", async () => {
        const { backend, connect } = await start();
        const client = await connect();

        await client.request("session.open");
        const { targetId } = (await client.request("tab.create")) as { targetId: string };
        const events: unknown[] = [];
        const closed: unknown[] = [];

        client.on("cdp.event", (params) => events.push(params));
        client.on("tab.closed", (params) => closed.push(params));
        await client.request("cdp.subscribe", { targetId, event: "Page.loadEventFired" });
        backend.sessions.get(targetId)?.emit("Page.loadEventFired", { timestamp: 7 });
        await client.request("cdp.unsubscribe", { targetId, event: "Page.loadEventFired" });
        backend.sessions.get(targetId)?.emit("Page.loadEventFired", { timestamp: 8 });
        backend.destroyTarget(targetId);
        await vi.waitFor(() => expect(closed).toEqual([{ targetId }]));
        expect(events).toEqual([{ targetId, event: "Page.loadEventFired", params: { timestamp: 7 } }]);
    });
});

describe("client lifetime", () => {
    it("cleans up the session when the client disconnects", async () => {
        const { backend, connect } = await start();
        const client = await connect();

        await client.request("session.open", { isolated: true });
        await client.request("tab.create");
        await client.close();
        await vi.waitFor(() => expect(backend.contexts.size).toBe(0));
        expect(backend.log).toContain("disposeContext ctx1");
    });

    it("cleans up only the session of the client that left", async () => {
        const { backend, connect } = await start();
        const staying = await connect("staying");
        const leaving = await connect("leaving");

        await staying.request("session.open", { isolated: true });
        await leaving.request("session.open", { isolated: true });
        const { targetId } = (await staying.request("tab.create")) as { targetId: string };

        await leaving.close();
        await vi.waitFor(() => expect(backend.contexts.size).toBe(1));
        await expect(
            staying.request("cdp.send", { targetId, method: "Page.enable" }),
        ).resolves.toBeDefined();
    });

    it("closes every session on shutdown", async () => {
        const { backend, daemon, connect } = await start();
        const client = await connect();

        await client.request("session.open", { isolated: true });
        await daemon.shutdown();
        expect(backend.contexts.size).toBe(0);
    });
});
