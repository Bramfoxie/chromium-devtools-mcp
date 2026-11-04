import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchVersion } from "../src/browser/attach.js";
import { createWsTransportFactory } from "../src/cdp/index.js";

const sockets = new Set<net.Socket>();
const servers: net.Server[] = [];

afterEach(async () => {
    for (const socket of sockets) socket.destroy();

    sockets.clear();
    await Promise.all(
        servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
});

async function listen(server: net.Server): Promise<number> {
    server.on("connection", (socket: net.Socket) => {
        sockets.add(socket);
        socket.resume();
        socket.on("end", () => socket.destroy());
        socket.on("close", () => sockets.delete(socket));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    return (server.address() as AddressInfo).port;
}

async function closedSockets(): Promise<void> {
    await expect.poll(() => sockets.size, { timeout: 2000 }).toBe(0);
}

describe("fetchVersion", () => {
    it("reads the version document and closes the connection", async () => {
        const port = await listen(
            http.createServer((_request, response) => {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://x" }));
            }),
        );

        await expect(fetchVersion(port)).resolves.toEqual({ webSocketDebuggerUrl: "ws://x" });
        await closedSockets();
    });

    it("gives up on a server that accepts the connection and never answers, and closes it", async () => {
        const port = await listen(net.createServer());
        const started = Date.now();

        await expect(fetchVersion(port, undefined, 100)).resolves.toBeUndefined();
        expect(Date.now() - started).toBeLessThan(1500);
        await closedSockets();
    });

    it("closes the connection after an error status with an unread body", async () => {
        const port = await listen(
            http.createServer((_request, response) => {
                response.writeHead(404, { "content-length": "100" });
                response.write("x");
            }),
        );

        await expect(fetchVersion(port)).resolves.toBeUndefined();
        await closedSockets();
    });

    it("closes the connection when aborted", async () => {
        const port = await listen(net.createServer());
        const controller = new AbortController();
        const pending = fetchVersion(port, controller.signal, 60_000);

        await expect.poll(() => sockets.size).toBe(1);
        controller.abort();
        await expect(pending).resolves.toBeUndefined();
        await closedSockets();
    });

    it("does not connect when already aborted", async () => {
        const port = await listen(net.createServer());

        await expect(fetchVersion(port, AbortSignal.abort())).resolves.toBeUndefined();
        expect(sockets.size).toBe(0);
    });
});

describe("websocket handshake budget", () => {
    it("is enforced as a total even when the server keeps sending bytes", async () => {
        const server = net.createServer((socket) => {
            socket.resume();
            let count = 0;
            const timer = setInterval(() => {
                socket.write(count === 0 ? "HTTP/1.1 101 Switching Protocols\r\n" : `X-${count}: y\r\n`);
                count += 1;
            }, 20);

            socket.on("close", () => clearInterval(timer));
            socket.on("error", () => undefined);
        });
        const port = await listen(server);
        const started = Date.now();

        await expect(
            createWsTransportFactory(250)(`ws://127.0.0.1:${port}/devtools/browser/x`),
        ).rejects.toThrow(/handshake did not finish within 250 ms/);
        expect(Date.now() - started).toBeLessThan(2000);
        await closedSockets();
    });
});
