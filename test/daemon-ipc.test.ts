import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    type AcceptOptions,
    acceptConnection,
    acquireInstance,
    type ClientConnection,
    ErrorCode,
    generateToken,
    IpcClient,
    IpcClosedError,
    IpcTimeoutError,
    LineDecoder,
    MAX_PENDING_CONNECTIONS,
    MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES,
    PendingConnections,
    type RequestHandler,
    RpcError,
} from "../src/daemon/index.js";
import { createSocketHarness } from "./helpers/daemon-socket.js";

const harness = createSocketHarness();

afterEach(async () => {
    await harness.dispose();
    vi.restoreAllMocks();
});

function quietStderr() {
    return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

async function startServer(overrides: Partial<AcceptOptions> = {}) {
    const options = await harness.options();
    const token = generateToken();
    const ready: ClientConnection[] = [];
    const closed: ClientConnection[] = [];
    const handle = await acquireInstance(options, (socket) =>
        acceptConnection(socket, {
            token,
            handler: async ({ method, params }) => {
                if (method === "echo") return params;

                if (method === "slow" || method === "cdp.send") {
                    const { ms, value } = params as { ms: number; value: string };

                    await new Promise((resolve) => setTimeout(resolve, ms));

                    return value;
                }

                if (method === "fail") throw new RpcError("custom_code", "custom failure");
                if (method === "boom") throw new Error("secret-xyz leaked detail");
                if (method === "hang") return new Promise<never>(() => undefined);

                throw new RpcError(ErrorCode.unknownMethod, `Unknown method ${method}.`);
            },
            onReady: (connection) => ready.push(connection),
            onClose: (connection) => closed.push(connection),
            ...overrides,
        }),
    );

    harness.track(() => handle.release());

    return { options, token, ready, closed, handle };
}

async function connectClient(
    server           : Awaited<ReturnType<typeof startServer>>,
    requestTimeoutMs?: number,
) {
    const client = await IpcClient.connect({
        socketPath: server.options.socketPath,
        token     : server.token,
        clientName: "test-client",
        requestTimeoutMs,
    });

    harness.track(() => client.close());

    return client;
}

interface RawClient {
    socket: net.Socket;
    lines : string[];
    closed: Promise<void>;
    send(text: string): void;
}

async function rawClient(socketPath: string): Promise<RawClient> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
        const created = net.connect(socketPath);

        created.once("connect", () => resolve(created));
        created.once("error", reject);
    });

    harness.track(async () => void socket.destroy());
    const decoder = new LineDecoder(MAX_RESPONSE_BYTES);
    const lines: string[] = [];

    socket.on("data", (chunk: Buffer) => lines.push(...decoder.push(chunk)));
    socket.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    return { socket, lines, closed, send: (text) => void socket.write(text) };
}

const hello = (token: string) =>
    `${JSON.stringify({ id: 1, method: "hello", params: { token, clientName: "raw" } })}\n`;

describe("handshake", () => {
    it("authenticates, exposes the client name and answers requests", async () => {
        const server = await startServer();
        const client = await connectClient(server);

        expect(server.ready.map((connection) => connection.clientName)).toEqual(["test-client"]);
        await expect(client.request("echo", { a: [1, 2] })).resolves.toEqual({ a: [1, 2] });
        await expect(client.request("echo")).resolves.toBeUndefined();
    });

    it("closes the connection on a wrong token", async () => {
        quietStderr();
        const server = await startServer();
        const failure = await IpcClient.connect({
            socketPath: server.options.socketPath,
            token     : generateToken(),
            clientName: "intruder",
        }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(IpcClosedError);
        expect((failure as Error).message).toContain("rejected the handshake");
        expect(server.ready).toEqual([]);
    });

    it.each([
        ["a request that is not a hello", '{"id":1,"method":"echo"}\n'],
        ["invalid JSON", "not json\n"],
        ["a hello without params", '{"id":1,"method":"hello"}\n'],
        [
            "a hello with an empty token",
            '{"id":1,"method":"hello","params":{"token":"","clientName":"x"}}\n',
        ],
    ])("drops a connection whose first message is %s", async (_name, text) => {
        const stderr = quietStderr();
        const server = await startServer();
        const raw = await rawClient(server.options.socketPath);

        raw.send(text);
        await raw.closed;
        expect(raw.lines).toEqual([]);
        expect(server.ready).toEqual([]);
        expect(stderr).toHaveBeenCalled();
    });

    it("drops a client that never sends a hello", async () => {
        quietStderr();
        const server = await startServer({ helloTimeoutMs: 50 });
        const raw = await rawClient(server.options.socketPath);

        await raw.closed;
        expect(server.ready).toEqual([]);
    });

    it("keeps an authenticated connection open past the hello timeout", async () => {
        const server = await startServer({ helloTimeoutMs: 50 });
        const client = await connectClient(server);

        await new Promise((resolve) => setTimeout(resolve, 150));
        await expect(client.request("echo", "still here")).resolves.toBe("still here");
    });

    it("closes a connection beyond the limit of connections waiting for a hello", async () => {
        const stderr = quietStderr();
        const server = await startServer({ pending: new PendingConnections(2) });
        const first = await rawClient(server.options.socketPath);
        const second = await rawClient(server.options.socketPath);
        const third = await rawClient(server.options.socketPath);

        await third.closed;
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining("too many connections"));
        expect(first.socket.destroyed).toBe(false);
        expect(second.socket.destroyed).toBe(false);

        first.send(hello(server.token));
        await vi.waitFor(() => expect(first.lines).toHaveLength(1));

        const fourth = await rawClient(server.options.socketPath);

        fourth.send(hello(server.token));
        await vi.waitFor(() => expect(fourth.lines).toHaveLength(1));
        expect(server.ready).toHaveLength(2);
    });

    it("frees a waiting slot when a connection closes without a hello", async () => {
        quietStderr();
        const server = await startServer({ pending: new PendingConnections(1) });
        const first = await rawClient(server.options.socketPath);

        first.socket.destroy();
        await first.closed;

        await vi.waitFor(async () => {
            const next = await rawClient(server.options.socketPath);

            next.send(hello(server.token));
            await vi.waitFor(() => expect(next.lines).toHaveLength(1), { timeout: 200 });
        });
    });

    it("allows 16 connections waiting for a hello by default", () => {
        expect(new PendingConnections().limit).toBe(MAX_PENDING_CONNECTIONS);
        expect(MAX_PENDING_CONNECTIONS).toBe(16);
    });

    it("ignores everything that follows a rejected first message in the same chunk", async () => {
        quietStderr();
        const server = await startServer();
        const raw = await rawClient(server.options.socketPath);

        raw.send(`{"id":1,"method":"echo"}\n${hello(server.token)}`);
        await raw.closed;
        expect(raw.lines).toEqual([]);
        expect(server.ready).toEqual([]);
    });

    it("never echoes the token or explains why a connection was refused", async () => {
        const stderr = quietStderr();
        const server = await startServer();
        const raw = await rawClient(server.options.socketPath);

        raw.send(hello("wrong-token-value"));
        await raw.closed;
        expect(raw.lines).toEqual([]);
        const logged = stderr.mock.calls.map((call) => String(call[0])).join("");

        expect(logged).not.toContain("wrong-token-value");
        expect(logged).not.toContain(server.token);
    });

    it("rejects a second hello on an open connection", async () => {
        const server = await startServer();
        const raw = await rawClient(server.options.socketPath);

        raw.send(hello(server.token));
        raw.send(hello(server.token).replace('"id":1', '"id":2'));
        await vi.waitFor(() => expect(raw.lines).toHaveLength(2));
        expect(JSON.parse(raw.lines[1] ?? "")).toMatchObject({
            id   : 2,
            error: { code: ErrorCode.badRequest },
        });
    });
});

describe("requests", () => {
    it("answers concurrent requests out of order by id", async () => {
        const server = await startServer();
        const client = await connectClient(server);
        const results: string[] = [];
        const slow = client
            .request("slow", { ms: 80, value: "slow" })
            .then((v) => results.push(String(v)));
        const fast = client
            .request("slow", { ms: 5, value: "fast" })
            .then((v) => results.push(String(v)));

        await Promise.all([slow, fast]);
        expect(results).toEqual(["fast", "slow"]);
    });

    it("turns an RpcError of the handler into a typed client error", async () => {
        const server = await startServer();
        const client = await connectClient(server);
        const failure = await client.request("fail").catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(RpcError);
        expect(failure).toMatchObject({ code: "custom_code", message: "custom failure" });
    });

    it("hides the details of unexpected handler errors", async () => {
        const stderr = quietStderr();
        const server = await startServer();
        const client = await connectClient(server);
        const failure = await client.request("boom").catch((error: unknown) => error);

        expect(failure).toMatchObject({ code: ErrorCode.internal });
        expect((failure as Error).message).not.toContain("secret-xyz");
        expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
            'request "boom" failed',
        );
    });

    it("answers unknown methods with a typed error and keeps the connection", async () => {
        const server = await startServer();
        const client = await connectClient(server);

        await expect(client.request("nope")).rejects.toMatchObject({ code: ErrorCode.unknownMethod });
        await expect(client.request("echo", 1)).resolves.toBe(1);
    });

    it("answers a malformed request that has an id with bad_request", async () => {
        const server = await startServer();
        const raw = await rawClient(server.options.socketPath);

        raw.send(hello(server.token));
        raw.send('{"id":7,"method":""}\n');
        await vi.waitFor(() => expect(raw.lines).toHaveLength(2));
        expect(JSON.parse(raw.lines[1] ?? "")).toMatchObject({
            id   : 7,
            error: { code: ErrorCode.badRequest },
        });
    });

    it.each([
        ["a malformed request without an id", '{"method":""}\n'],
        ["invalid JSON", "{broken\n"],
        ["an oversized line", `${"x".repeat(MAX_REQUEST_BYTES + 10)}\n`],
    ])("drops the connection after %s", async (_name, text) => {
        quietStderr();
        const server = await startServer();
        const raw = await rawClient(server.options.socketPath);

        raw.send(hello(server.token));
        await vi.waitFor(() => expect(raw.lines).toHaveLength(1));
        raw.send(text);
        await raw.closed;
    });

    it("clears the request timer when the response arrives", async () => {
        const server = await startServer();
        const client = await connectClient(server);

        vi.useFakeTimers();

        try {
            await client.request("echo", 1);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects locally when the signal aborts and keeps serving", async () => {
        const server = await startServer();
        const client = await connectClient(server);
        const controller = new AbortController();
        const pending = client.request("hang", undefined, { signal: controller.signal });

        controller.abort();
        await expect(pending).rejects.toThrow(/was cancelled/);
        await expect(client.request("echo", "next")).resolves.toBe("next");
    });

    it("ignores a response that arrives after the request timed out", async () => {
        const server = await startServer();
        const client = await connectClient(server);

        await expect(
            client.request("slow", { ms: 80, value: "late" }, { timeoutMs: 20 }),
        ).rejects.toBeInstanceOf(IpcTimeoutError);
        await new Promise((resolve) => setTimeout(resolve, 120));
        await expect(client.request("echo", "next")).resolves.toBe("next");
    });

    it("rejects requests that cannot be encoded instead of throwing", async () => {
        const server = await startServer();
        const client = await connectClient(server);
        const circular: Record<string, unknown> = {};

        circular.self = circular;
        await expect(client.request("echo", circular)).rejects.toThrow();
        await expect(client.request("echo", 1n)).rejects.toThrow();
        await expect(client.request("echo", "x".repeat(MAX_REQUEST_BYTES + 1))).rejects.toThrow(
            /exceeds/,
        );
        await expect(client.request("echo", "ok")).resolves.toBe("ok");
    });

    it("waits for a request that declares a longer timeout than the default", async () => {
        const server = await startServer();
        const client = await connectClient(server, 40);

        await expect(client.request("slow", { ms: 120, value: "late" })).rejects.toBeInstanceOf(
            IpcTimeoutError,
        );
        await expect(
            client.request("slow", { ms: 120, value: "done", timeoutMs: 500 }),
        ).resolves.toBe("done");
        await expect(
            client.request("slow", { ms: 120, value: "x", timeoutMs: 500 }, { timeoutMs: 20 }),
        ).rejects.toMatchObject({ timeoutMs: 20 });
    });

    it("gives cdp.send and tab.create without a declared timeout a margin over the default", async () => {
        const server = await startServer();
        const client = await connectClient(server, 40);

        await expect(client.request("cdp.send", { ms: 120, value: "late" })).resolves.toBe("late");
        await expect(client.request("slow", { ms: 120, value: "late" })).rejects.toBeInstanceOf(
            IpcTimeoutError,
        );
    });

    it("times out a request and honors a per-request timeout", async () => {
        const server = await startServer();
        const client = await connectClient(server, 40);
        const failure = await client.request("hang").catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(IpcTimeoutError);
        expect(failure).toMatchObject({ method: "hang", timeoutMs: 40 });
        await expect(client.request("hang", undefined, { timeoutMs: 20 })).rejects.toMatchObject({
            timeoutMs: 20,
        });
    });

    it("passes a response between 1 MiB and 32 MiB", async () => {
        const server = await startServer({
            handler: async ({ method }) =>
                method === "big" ? "x".repeat(MAX_REQUEST_BYTES + 100) : "alive",
        });
        const client = await connectClient(server);

        await expect(client.request("big")).resolves.toHaveLength(MAX_REQUEST_BYTES + 100);
        await expect(client.request("other")).resolves.toBe("alive");
    });

    it("keeps the connection alive for a 20 MiB response", async () => {
        const body = "x".repeat(20 * 1024 * 1024);
        const server = await startServer({
            handler: async ({ method }) => (method === "big" ? body : "alive"),
        });
        const client = await connectClient(server);

        await expect(client.request("big")).resolves.toHaveLength(body.length);
        await expect(client.request("other")).resolves.toBe("alive");
    });

    it("refuses a request above 1 MiB and keeps the connection usable", async () => {
        const server = await startServer();
        const client = await connectClient(server);
        const failure = await client
            .request("echo", "x".repeat(MAX_REQUEST_BYTES + 1))
            .catch((error: unknown) => error);

        expect(String((failure as Error).message)).toContain("exceeds");
        await expect(client.request("echo", "ok")).resolves.toBe("ok");
    });

    it("does not crash the server when a handler finishes after the client left", async () => {
        const server = await startServer();
        const client = await connectClient(server);
        const pending = client.request("slow", { ms: 60, value: "late" }).catch(() => undefined);

        await client.close();
        await pending;
        await new Promise((resolve) => setTimeout(resolve, 100));
        const second = await connectClient(server);

        await expect(second.request("echo", "alive")).resolves.toBe("alive");
    });
});

describe("handler failures", () => {
    it.each([
        ["a result above the size limit", async () => "x".repeat(MAX_RESPONSE_BYTES)],
        ["a BigInt result", async () => 10n],
        [
            "a circular result",
            async () => {
                const loop: Record<string, unknown> = {};

                loop.self = loop;

                return loop;
            },
        ],
    ])("answers with an error for %s and keeps serving", async (name, produce) => {
        const stderr = quietStderr();
        const server = await startServer({
            handler: async ({ method }) => (method === "produce" ? produce() : "alive"),
        });
        const client = await connectClient(server);

        await expect(client.request("produce")).rejects.toMatchObject({
            code: name.includes("size limit") ? ErrorCode.resultTooLarge : ErrorCode.internal,
        });
        await expect(client.request("other")).resolves.toBe("alive");
        expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
            "could not encode a response",
        );
    });

    it("survives a handler that throws synchronously", async () => {
        quietStderr();
        const handler = (() => {
            throw new Error("sync failure");
        }) as unknown as RequestHandler;
        const server = await startServer({ handler });
        const client = await connectClient(server);

        await expect(client.request("any")).rejects.toMatchObject({ code: ErrorCode.internal });
        await expect(client.request("any")).rejects.toMatchObject({ code: ErrorCode.internal });
    });

    it("does not let attacker controlled names forge log lines", async () => {
        const stderr = quietStderr();
        const server = await startServer({
            handler: async () => {
                throw new Error("detail\nchromium-devtools-mcp: FORGED");
            },
        });
        const client = await connectClient(server);

        await client.request("name\u001b[31m\nFORGED").catch(() => undefined);
        const logged = stderr.mock.calls.map((call) => String(call[0])).join("");

        expect(logged.trimEnd().split("\n")).toHaveLength(1);
        expect(logged).not.toContain("\u001b");
    });

    it("limits the number of requests in flight per connection", async () => {
        const server = await startServer();
        const raw = await rawClient(server.options.socketPath);

        raw.send(hello(server.token));
        for (let id = 2; id <= 65; id += 1) raw.send(`{"id":${id},"method":"hang"}\n`);
        raw.send('{"id":66,"method":"hang"}\n');
        await vi.waitFor(() => expect(raw.lines).toHaveLength(2));
        expect(JSON.parse(raw.lines[1] ?? "")).toMatchObject({
            id   : 66,
            error: { code: ErrorCode.busy },
        });
    });

    it("frees an in-flight slot when a request completes", async () => {
        const server = await startServer();
        const client = await connectClient(server);

        for (let round = 0; round < 3; round += 1) {
            await Promise.all(Array.from({ length: 40 }, () => client.request("echo", round)));
        }
    });

    it("drops a client that does not read its events", async () => {
        quietStderr();
        const server = await startServer();
        const raw = await rawClient(server.options.socketPath);

        raw.socket.pause();
        raw.send(hello(server.token));
        await vi.waitFor(() => expect(server.ready).toHaveLength(1));
        const chunk = "x".repeat(900_000);

        for (let i = 0; i < 80 && !raw.socket.destroyed; i += 1) {
            server.ready[0]?.sendEvent("big", chunk);
        }

        raw.socket.resume();
        await raw.closed;
    });

    it("drops a connection whose request id is not a safe integer", async () => {
        quietStderr();
        const server = await startServer();
        const raw = await rawClient(server.options.socketPath);

        raw.send(hello(server.token));
        await vi.waitFor(() => expect(raw.lines).toHaveLength(1));
        raw.send('{"id":1e300,"method":""}\n');
        await raw.closed;
    });

    it("survives exceptions thrown by the lifecycle callbacks", async () => {
        const stderr = quietStderr();
        const server = await startServer({
            onReady: () => {
                throw new Error("ready failed");
            },
            onClose: () => {
                throw new Error("close failed");
            },
        });
        const first = await connectClient(server);

        await first.close();
        await vi.waitFor(() =>
            expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("onClose failed"),
        );
        const second = await connectClient(server);

        await expect(second.request("echo", 1)).resolves.toBe(1);
    });
});

describe("bare sockets", () => {
    it("does not crash on a socket error and clears the hello timer on close", () => {
        vi.useFakeTimers();

        try {
            const socket = new net.Socket();

            acceptConnection(socket, { token: generateToken(), handler: async () => undefined });
            expect(vi.getTimerCount()).toBe(1);
            expect(() => socket.emit("error", new Error("ECONNRESET"))).not.toThrow();
            socket.emit("close");
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("events", () => {
    it("delivers server events to subscribers and stops after unsubscribe", async () => {
        const server = await startServer();
        const client = await connectClient(server);
        const seen: unknown[] = [];
        const off = client.on("tick", (params) => {
            seen.push(params);
            off();
        });

        server.ready[0]?.sendEvent("tick", { n: 1 });
        server.ready[0]?.sendEvent("tick", { n: 2 });
        await client.request("echo");
        expect(seen).toEqual([{ n: 1 }]);
    });

    it("does not register handlers on a closed client", async () => {
        const server = await startServer();
        const client = await connectClient(server);

        await client.close();
        const handler = vi.fn();
        const off = client.on("tick", handler);

        expect(() => off()).not.toThrow();
    });

    it("does nothing when an event is sent to a closed connection", async () => {
        const server = await startServer();
        const client = await connectClient(server);
        const connection = server.ready[0];

        await client.close();
        await vi.waitFor(() => expect(server.closed).toHaveLength(1));
        expect(() => connection?.sendEvent("tick", 1)).not.toThrow();
    });

    it("keeps a throwing event handler from breaking others", async () => {
        const stderr = quietStderr();
        const server = await startServer();
        const client = await connectClient(server);
        const good = vi.fn();

        client.on("tick", () => {
            throw new Error("boom");
        });
        client.on("tick", good);
        server.ready[0]?.sendEvent("tick");
        await client.request("echo");
        expect(good).toHaveBeenCalledTimes(1);
        expect(stderr).toHaveBeenCalled();
    });

    it("drops an event that cannot be encoded and logs it", async () => {
        const stderr = quietStderr();
        const server = await startServer();
        const client = await connectClient(server);
        const seen: unknown[] = [];

        client.on("tick", (params) => seen.push(params));
        const cyclic: Record<string, unknown> = {};

        cyclic.self = cyclic;
        server.ready[0]?.sendEvent("tick", cyclic);
        server.ready[0]?.sendEvent("tick", { n: 1 });
        await client.request("echo");
        expect(seen).toEqual([{ n: 1 }]);
        expect(stderr).toHaveBeenCalled();
    });
});

describe("closing", () => {
    it("rejects pending requests when the daemon drops the connection", async () => {
        const server = await startServer();
        const client = await connectClient(server);
        const pending = client.request("hang").catch((error: unknown) => error);

        await vi.waitFor(() => expect(server.ready).toHaveLength(1));
        server.ready[0]?.close();
        expect(await pending).toBeInstanceOf(IpcClosedError);
        expect(client.closed).toBe(true);
    });

    it("clears request timers when the client closes", async () => {
        const server = await startServer();
        const client = await connectClient(server);

        vi.useFakeTimers();

        try {
            const pending = client.request("hang").catch((error: unknown) => error);

            expect(vi.getTimerCount()).toBe(1);
            await client.close();
            expect(await pending).toBeInstanceOf(IpcClosedError);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("notifies the server when a client closes and is idempotent", async () => {
        const server = await startServer();
        const client = await connectClient(server);

        await client.close();
        await client.close();
        await vi.waitFor(() => expect(server.closed).toHaveLength(1));
        expect(server.closed[0]?.clientName).toBe("test-client");
        await expect(client.request("echo")).rejects.toBeInstanceOf(IpcClosedError);
    });

    it("does not report a close for a connection that never authenticated", async () => {
        quietStderr();
        const server = await startServer();
        const raw = await rawClient(server.options.socketPath);

        raw.send("garbage\n");
        await raw.closed;
        expect(server.closed).toEqual([]);
    });

    it("reports an unreachable daemon as IpcClosedError", async () => {
        const options = await harness.options();
        const failure = await IpcClient.connect({
            socketPath: options.socketPath,
            token     : generateToken(),
            clientName: "x",
        }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(IpcClosedError);
        expect((failure as Error).message).toContain("cannot reach the daemon");
    });

    it("serves several clients with separate identities", async () => {
        const server = await startServer();
        const first = await connectClient(server);
        const second = await IpcClient.connect({
            socketPath: server.options.socketPath,
            token     : server.token,
            clientName: "other-client",
        });

        harness.track(() => second.close());
        await expect(
            Promise.all([first.request("echo", 1), second.request("echo", 2)]),
        ).resolves.toEqual([1, 2]);
        expect(server.ready.map((connection) => connection.clientName).sort()).toEqual([
            "other-client",
            "test-client",
        ]);
    });
});
