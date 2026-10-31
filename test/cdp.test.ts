import { createHash } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import {
  CdpClient,
  CdpClosedError,
  CdpError,
  CdpProtocolError,
  CdpTimeoutError,
  createWsTransportFactory,
  type Transport,
} from "../src/cdp/index.js";

interface Rpc {
  id        : number;
  method    : string;
  params?   : Record<string, unknown>;
  sessionId?: string;
}

type RpcHandler = (rpc: Rpc, socket: WebSocket) => void;

const servers: WebSocketServer[] = [];
const clients: CdpClient[] = [];
const rawServers: net.Server[] = [];
const rawSockets: net.Socket[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const socket of rawSockets.splice(0)) socket.destroy();
  await Promise.all(
    rawServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(
    servers.splice(0).map((server) => {
      for (const socket of server.clients) socket.terminate();

      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  vi.restoreAllMocks();
});

async function startServer(handler: RpcHandler) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });

  servers.push(server);
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (data: RawData) => {
      handler(JSON.parse(data.toString()) as Rpc, socket);
    });
  });
  const { port } = server.address() as AddressInfo;

  return { server, url: `ws://127.0.0.1:${port}` };
}

async function connect(handler: RpcHandler, requestTimeoutMs?: number) {
  const { server, url } = await startServer(handler);
  const client = await CdpClient.connect({ url, requestTimeoutMs });

  clients.push(client);

  return { server, client };
}

function reply(socket: WebSocket, id: number, result: unknown, sessionId?: string) {
  socket.send(JSON.stringify({ id, result, sessionId }));
}

function emit(socket: WebSocket, method: string, params: unknown, sessionId?: string) {
  socket.send(JSON.stringify({ method, params, sessionId }));
}

const echo: RpcHandler = (rpc, socket) => {
  reply(socket, rpc.id, { method: rpc.method, params: rpc.params ?? null }, rpc.sessionId);
};

function silentStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

describe("requests", () => {
  it("resolves a request with the result", async () => {
    const { client } = await connect(echo);

    await expect(client.send("Browser.getVersion", { a: 1 })).resolves.toEqual({
      method: "Browser.getVersion",
      params: { a: 1 },
    });
  });

  it("matches concurrent responses by id", async () => {
    const held: Rpc[] = [];
    const { client } = await connect((rpc, socket) => {
      held.push(rpc);

      if (held.length === 3) {
        for (const item of [...held].reverse()) reply(socket, item.id, item.method);
      }
    });
    const results = await Promise.all([client.send("A"), client.send("B"), client.send("C")]);

    expect(results).toEqual(["A", "B", "C"]);
  });

  it("rejects with CdpProtocolError when the browser answers with an error", async () => {
    const { client } = await connect((rpc, socket) => {
      socket.send(JSON.stringify({ id: rpc.id, error: { code: -32601, message: "not found" } }));
    });
    const failure = await client.send("Nope.nope").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CdpProtocolError);
    expect(failure).toBeInstanceOf(CdpError);
    expect(failure).toMatchObject({ method: "Nope.nope", code: -32601 });
    expect((failure as Error).message).toContain("not found");
  });

  it("treats any present error field as a failure", async () => {
    const { client } = await connect((rpc, socket) => {
      socket.send(JSON.stringify({ id: rpc.id, error: "boom" }));
    });
    const failure = await client.send("Nope.nope").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CdpProtocolError);
    expect(failure).toMatchObject({ method: "Nope.nope", code: undefined });
    expect((failure as Error).message).toContain("boom");
  });

  it("falls back to a default detail when the error has no code or message", async () => {
    const { client } = await connect((rpc, socket) => {
      socket.send(JSON.stringify({ id: rpc.id, error: {} }));
    });
    const failure = await client.send("Nope.nope").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CdpProtocolError);
    expect((failure as Error).message).toContain("no details");
  });

  it("rejects with CdpTimeoutError when no response arrives", async () => {
    const { client } = await connect(() => undefined, 50);
    const failure = await client.send("Slow.method").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CdpTimeoutError);
    expect(failure).toMatchObject({ method: "Slow.method", timeoutMs: 50 });
  });

  it("lets a per-request timeout override the default", async () => {
    const { client } = await connect(() => undefined, 60_000);
    const failure = await client
      .send("Slow.method", {}, { timeoutMs: 30 })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ timeoutMs: 30 });
  });

  it("does not leak params or results into error messages", async () => {
    const { client } = await connect(() => undefined, 30);
    const failure = await client
      .send("Network.setCookie", { value: "secret-cookie" })
      .catch((error: unknown) => error);

    expect((failure as Error).message).not.toContain("secret-cookie");
  });

  it("rejects with CdpError, not CdpClosedError, when params cannot be serialized", async () => {
    const { client } = await connect(echo);
    const failure = await client.send("X", { n: 1n }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CdpError);
    expect(failure).not.toBeInstanceOf(CdpClosedError);
    expect(client.closed).toBe(false);
  });

  it("ignores invalid JSON and unknown ids", async () => {
    const stderr = silentStderr();
    const { client } = await connect((rpc, socket) => {
      socket.send("not json");
      socket.send(JSON.stringify([1, 2]));
      reply(socket, rpc.id + 1000, "stray");
      reply(socket, rpc.id, "ok");
    });

    await expect(client.send("X")).resolves.toBe("ok");
    expect(stderr).toHaveBeenCalledTimes(3);
  });

  it("logs messages without an id and without a method", async () => {
    const stderr = silentStderr();
    const { client } = await connect((rpc, socket) => {
      socket.send(JSON.stringify({}));
      socket.send(JSON.stringify({ id: "one", result: "stray" }));
      reply(socket, rpc.id, "ok");
    });

    await expect(client.send("X")).resolves.toBe("ok");
    expect(stderr).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid timeouts instead of firing instantly", async () => {
    const { client } = await connect(echo);

    for (const timeoutMs of [Number.NaN, -1, Number.POSITIVE_INFINITY, 2 ** 31]) {
      await expect(client.send("X", {}, { timeoutMs })).rejects.toBeInstanceOf(CdpError);
      await expect(client.once("X.event", undefined, timeoutMs)).rejects.toBeInstanceOf(CdpError);
    }

    await expect(CdpClient.connect({ url: "ws://unused", requestTimeoutMs: -1 })).rejects.toBeInstanceOf(
      CdpError,
    );
    expect(client.closed).toBe(false);
  });

  it("rejects when the transport throws synchronously", async () => {
    const timers = vi.spyOn(globalThis, "clearTimeout");
    const client = await CdpClient.connect({
      url            : "ws://unused",
      createTransport: async () => ({
        send: () => {
          throw new Error("socket is closed");
        },
        close    : async () => undefined,
        onMessage: () => undefined,
        onClose  : () => undefined,
      }),
    });

    clients.push(client);
    const failure = await client.send("X").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CdpClosedError);
    expect((failure as Error).message).toContain("socket is closed");
    expect(timers).toHaveBeenCalled();
  });
});

describe("connect", () => {
  it("rejects with CdpClosedError when the endpoint is unreachable", async () => {
    const { server, url } = await startServer(echo);

    server.close();
    await expect(CdpClient.connect({ url })).rejects.toBeInstanceOf(CdpClosedError);
  });

  it("rejects with CdpClosedError for a malformed URL", async () => {
    const failure = await CdpClient.connect({ url: "http://[::1" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CdpClosedError);
    expect((failure as Error).message).toContain("cannot connect");
  });

  it("uses an injected transport factory", async () => {
    const sent: string[] = [];
    let deliver: (data: string) => void = () => undefined;
    const transport: Transport = {
      send: (data) => {
        sent.push(data);
        const { id } = JSON.parse(data) as { id: number };

        deliver(JSON.stringify({ id, result: "pong" }));
      },
      close    : async () => undefined,
      onMessage: (handler) => {
        deliver = handler;
      },
      onClose: () => undefined,
    };
    const client = await CdpClient.connect({
      url            : "ws://unused",
      createTransport: async (url) => {
        expect(url).toBe("ws://unused");

        return transport;
      },
    });

    await expect(client.send("Ping")).resolves.toBe("pong");
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({ id: 1, method: "Ping" });
  });
});

describe("events", () => {
  it("delivers events to subscribers and stops after unsubscribe", async () => {
    const { client } = await connect((rpc, socket) => {
      emit(socket, "Page.loadEventFired", { n: 1 });
      emit(socket, "Page.loadEventFired", { n: 2 });
      reply(socket, rpc.id, null);
    });
    const seen: unknown[] = [];
    const off = client.on("Page.loadEventFired", (params) => {
      seen.push(params);
      off();
    });

    await client.send("Go");
    await client.send("Go");
    expect(seen).toEqual([{ n: 1 }]);
  });

  it("resolves once with the next event", async () => {
    const { client } = await connect((rpc, socket) => {
      reply(socket, rpc.id, null);
      emit(socket, "Page.frameStoppedLoading", { frameId: "f1" });
    });
    const next = client.once("Page.frameStoppedLoading");

    await client.send("Go");
    await expect(next).resolves.toEqual({ frameId: "f1" });
  });

  it("rejects once on timeout", async () => {
    const { client } = await connect(echo);

    await expect(client.once("Never.happens", undefined, 30)).rejects.toBeInstanceOf(
      CdpTimeoutError,
    );
  });

  it("keeps a throwing handler from breaking other handlers", async () => {
    const stderr = silentStderr();
    const { client } = await connect((rpc, socket) => {
      emit(socket, "Log.entryAdded", {});
      reply(socket, rpc.id, null);
    });
    const good = vi.fn();

    client.on("Log.entryAdded", () => {
      throw new Error("boom");
    });
    client.on("Log.entryAdded", good);
    await client.send("Go");
    expect(good).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it("skips a handler removed during dispatch and ignores one added there", async () => {
    let deliver: (data: string) => void = () => undefined;
    const client = await CdpClient.connect({
      url            : "ws://unused",
      createTransport: async () => ({
        send     : () => undefined,
        close    : async () => undefined,
        onMessage: (handler) => {
          deliver = handler;
        },
        onClose: () => undefined,
      }),
    });

    clients.push(client);
    const calls: string[] = [];
    const late = () => {
      calls.push("late");
    };
    const off = client.on("X.event", () => {
      calls.push("first");
      off();
      client.on("X.event", late);
    });

    deliver(JSON.stringify({ method: "X.event", params: {} }));
    expect(calls).toEqual(["first"]);
    deliver(JSON.stringify({ method: "X.event", params: {} }));
    expect(calls).toEqual(["first", "late"]);
  });

  it("treats a non-string session id as a root event", async () => {
    const { client } = await connect((rpc, socket) => {
      socket.send(JSON.stringify({ method: "X.event", params: { n: 1 }, sessionId: 7 }));
      reply(socket, rpc.id, null);
    });
    const root = vi.fn();

    client.on("X.event", root);
    await client.send("Go");
    expect(root).toHaveBeenCalledWith({ n: 1 }, undefined);
  });
});

describe("sessions", () => {
  const browser: RpcHandler = (rpc, socket) => {
    if (rpc.method === "Target.attachToTarget") {
      reply(socket, rpc.id, { sessionId: `s-${String(rpc.params?.targetId)}` });
    } else if (rpc.method === "Target.detachFromTarget") {
      reply(socket, rpc.id, {});
    } else if (rpc.method === "Emit.toSession") {
      emit(socket, "Page.loadEventFired", {}, String(rpc.params?.target));
      reply(socket, rpc.id, null);
    } else if (rpc.method === "Emit.event") {
      emit(socket, "Page.loadEventFired", { from: rpc.sessionId }, rpc.sessionId);
      emit(socket, "Page.loadEventFired", { from: "root" });
      reply(socket, rpc.id, null, rpc.sessionId);
    } else {
      echo(rpc, socket);
    }
  };

  it("attaches with flatten and returns a session", async () => {
    const calls: Rpc[] = [];
    const { client } = await connect((rpc, socket) => {
      calls.push(rpc);
      browser(rpc, socket);
    });
    const session = await client.attach("t1");

    expect(session).toMatchObject({ sessionId: "s-t1", targetId: "t1" });
    expect(calls[0]?.params).toEqual({ targetId: "t1", flatten: true });
  });

  it("rejects attach when the response has no sessionId", async () => {
    const { client } = await connect((rpc, socket) => reply(socket, rpc.id, {}));

    await expect(client.attach("t1")).rejects.toBeInstanceOf(CdpProtocolError);
  });

  it("sends commands with the session id", async () => {
    const calls: Rpc[] = [];
    const { client } = await connect((rpc, socket) => {
      calls.push(rpc);
      browser(rpc, socket);
    });
    const session = await client.attach("t1");

    await session.send("Page.enable");
    await client.send("Browser.getVersion");
    expect(calls[1]?.sessionId).toBe("s-t1");
    expect(calls[2]?.sessionId).toBeUndefined();
  });

  it("routes events to the matching session only", async () => {
    const { client } = await connect(browser);
    const first = await client.attach("a");
    const second = await client.attach("b");
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    const onRoot = vi.fn();

    first.on("Page.loadEventFired", onFirst);
    second.on("Page.loadEventFired", onSecond);
    client.on("Page.loadEventFired", onRoot);
    await first.send("Emit.event");
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(onFirst).toHaveBeenCalledWith({ from: "s-a" }, "s-a");
    expect(onSecond).not.toHaveBeenCalled();
    expect(onRoot).toHaveBeenCalledTimes(1);
    expect(onRoot).toHaveBeenCalledWith({ from: "root" }, undefined);
  });

  it("resolves once with the next session event", async () => {
    const { client } = await connect(browser);
    const session = await client.attach("a");
    const next = client.once("Page.loadEventFired", session.sessionId);

    await session.send("Emit.event");
    await expect(next).resolves.toEqual({ from: "s-a" });
  });

  it("clears session listeners on detach", async () => {
    const { client } = await connect(browser);
    const session = await client.attach("a");
    const handler = vi.fn();

    session.on("Page.loadEventFired", handler);
    await client.send("Emit.toSession", { target: "s-a" });
    expect(handler).toHaveBeenCalledTimes(1);
    await session.detach();
    await client.send("Emit.toSession", { target: "s-a" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("clears session listeners even when detach fails", async () => {
    const { client } = await connect((rpc, socket) => {
      if (rpc.method === "Target.detachFromTarget") {
        socket.send(JSON.stringify({ id: rpc.id, error: { code: -32602, message: "gone" } }));
      } else {
        browser(rpc, socket);
      }
    });
    const session = await client.attach("a");
    const handler = vi.fn();

    session.on("Page.loadEventFired", handler);
    await expect(session.detach()).rejects.toBeInstanceOf(CdpProtocolError);
    await client.send("Emit.toSession", { target: "s-a" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("clears session listeners when the browser detaches the target", async () => {
    const { client } = await connect((rpc, socket) => {
      if (rpc.method === "Emit.detached") {
        emit(socket, "Target.detachedFromTarget", { sessionId: "s-a" });
        reply(socket, rpc.id, null);
      } else {
        browser(rpc, socket);
      }
    });
    const session = await client.attach("a");
    const handler = vi.fn();

    session.on("Page.loadEventFired", handler);
    await client.send("Emit.toSession", { target: "s-a" });
    expect(handler).toHaveBeenCalledTimes(1);
    await client.send("Emit.detached");
    await client.send("Emit.toSession", { target: "s-a" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects an in-flight session request as soon as the target detaches", async () => {
    const held: Rpc[] = [];
    const { client } = await connect((rpc, socket) => {
      if (rpc.method === "Hold") {
        held.push(rpc);

        return;
      }

      browser(rpc, socket);
    });
    const session = await client.attach("a");
    const pending = session.send("Hold").catch((error: unknown) => error);

    await vi.waitFor(() => expect(held).toHaveLength(1));
    client.dropSession(session.sessionId);
    const failure = await pending;

    expect(failure).toBeInstanceOf(CdpProtocolError);
    expect((failure as CdpProtocolError).method).toBe("Hold");
    expect((failure as Error).message).toContain("detached");
    expect(client.closed).toBe(false);
  });

  it("rejects a session-scoped once waiter as soon as the target detaches", async () => {
    const { client } = await connect(browser);
    const session = await client.attach("a");
    const waiting = client
      .once("Page.loadEventFired", session.sessionId, 30_000)
      .catch((error: unknown) => error);

    client.dropSession(session.sessionId);
    const failure = await waiting;

    expect(failure).toBeInstanceOf(CdpProtocolError);
    expect((failure as CdpProtocolError).method).toBe("Page.loadEventFired");
    expect((failure as Error).message).toContain("detached");
  });
});

describe("closing", () => {
  it("rejects pending requests when the server drops the connection", async () => {
    const { client } = await connect((_rpc, socket) => socket.terminate());
    const failure = await client.send("Any").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CdpClosedError);
    expect(client.closed).toBe(true);
  });

  it("rejects pending once waiters when the connection drops", async () => {
    const { client } = await connect((_rpc, socket) => socket.terminate());
    const waiting = client.once("Never.happens");
    const request = client.send("Any").catch((error: unknown) => error);

    await expect(waiting).rejects.toBeInstanceOf(CdpClosedError);
    await request;
  });

  it("rejects pending requests and is idempotent on close", async () => {
    const { client } = await connect(() => undefined);
    const pending = client.send("Never.answered").catch((error: unknown) => error);

    await client.close();
    await client.close();
    expect(await pending).toBeInstanceOf(CdpClosedError);
    expect(client.closed).toBe(true);
  });

  it("rejects send after close", async () => {
    const { client } = await connect(echo);

    await client.close();
    await expect(client.send("Any")).rejects.toBeInstanceOf(CdpClosedError);
    await expect(client.once("Any.event")).rejects.toBeInstanceOf(CdpClosedError);
  });

  it("does not deliver events after close", async () => {
    let deliver: (data: string) => void = () => undefined;
    const client = await CdpClient.connect({
      url            : "ws://unused",
      createTransport: async () => ({
        send     : () => undefined,
        close    : async () => undefined,
        onMessage: (handler) => {
          deliver = handler;
        },
        onClose: () => undefined,
      }),
    });
    const handler = vi.fn();

    client.on("Late.event", handler);
    deliver(JSON.stringify({ method: "Late.event", params: {} }));
    expect(handler).toHaveBeenCalledTimes(1);
    await client.close();
    deliver(JSON.stringify({ method: "Late.event", params: {} }));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

async function startRawServer(afterHandshake: (socket: net.Socket) => void) {
  const server = net.createServer((socket) => {
    rawSockets.push(socket);
    socket.once("data", (data) => {
      const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(data.toString())?.[1] ?? "";
      const accept = createHash("sha1")
        .update(key + WS_GUID)
        .digest("base64");

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
          `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      afterHandshake(socket);
    });
  });

  rawServers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("transport failures", () => {
  it("rejects pending requests with the reason when the socket errors after open", async () => {
    const url = await startRawServer((socket) => {
      setTimeout(() => socket.write(Buffer.from([0xf0, 0x00])), 20);
    });
    const client = await CdpClient.connect({ url });

    clients.push(client);
    const failure = await client.send("Any").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CdpClosedError);
    expect((failure as Error).message).toContain("Invalid WebSocket frame");
  });

  it("forces the socket down when the peer ignores the close handshake", async () => {
    const url = await startRawServer(() => undefined);
    const client = await CdpClient.connect({ url });
    const started = Date.now();

    await client.close();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(900);
  });
});

describe("handshake timeout", () => {
  it("fails when the peer accepts the connection but never answers the upgrade", async () => {
    const server = net.createServer((socket) => rawSockets.push(socket));

    rawServers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const failure = await createWsTransportFactory(100)(url).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CdpClosedError);
    expect((failure as Error).message).toContain("handshake");
  });
});

describe("close ordering", () => {
  it("waits for the transport to finish closing", async () => {
    let release: () => void = () => undefined;
    const client = await CdpClient.connect({
      url            : "ws://unused",
      createTransport: async () => ({
        send     : () => undefined,
        close    : () => new Promise<void>((resolve) => (release = resolve)),
        onMessage: () => undefined,
        onClose  : () => undefined,
      }),
    });
    let done = false;
    const closing = client.close().then(() => (done = true));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    release();
    await closing;
    expect(done).toBe(true);
  });

  it("makes concurrent close calls wait for the same transport close", async () => {
    let closes = 0;
    let release: () => void = () => undefined;
    const client = await CdpClient.connect({
      url            : "ws://unused",
      createTransport: async () => ({
        send : () => undefined,
        close: () => {
          closes += 1;

          return new Promise<void>((resolve) => (release = resolve));
        },
        onMessage: () => undefined,
        onClose  : () => undefined,
      }),
    });
    let first = false;
    let second = false;
    const one = client.close().then(() => (first = true));
    const two = client.close().then(() => (second = true));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first).toBe(false);
    expect(second).toBe(false);
    release();
    await Promise.all([one, two]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(closes).toBe(1);
  });
});

describe("onClose", () => {
  it("notifies once when the server drops the connection", async () => {
    const { client } = await connect((_rpc, socket) => socket.terminate());
    const handler = vi.fn();

    client.onClose(handler);
    await client.send("Any").catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("notifies when the client is closed locally and not after unsubscribe", async () => {
    const { client } = await connect(echo);
    const kept = vi.fn();
    const removed = vi.fn();

    client.onClose(kept);
    client.onClose(removed)();
    await client.close();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
  });

  it("calls a handler registered after the close", async () => {
    const { client } = await connect(echo);

    await client.close();
    const handler = vi.fn();

    client.onClose(handler);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("survives a late handler that throws and honors an immediate unsubscribe", async () => {
    const stderr = silentStderr();
    const { client } = await connect(echo);

    await client.close();
    client.onClose(() => {
      throw new Error("late boom");
    });
    const cancelled = vi.fn();

    client.onClose(cancelled)();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelled).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it("keeps a throwing handler from breaking the others", async () => {
    const stderr = silentStderr();
    const { client } = await connect(echo);
    const good = vi.fn();

    client.onClose(() => {
      throw new Error("boom");
    });
    client.onClose(good);
    await client.close();
    expect(good).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalled();
  });
});
