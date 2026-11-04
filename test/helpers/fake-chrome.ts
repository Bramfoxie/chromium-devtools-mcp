import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { AttachDeps } from "../../src/browser/attach.js";

export type UpgradeMode = "immediate" | "delayed" | "never";

// Stands in for a Chrome whose remote debugging toggle is switched on later.
export class FakeChrome {
    readonly home       : string;
    readonly userDataDir: string;
    readonly sockets = new Set<net.Socket>();
    readonly upgrades   : string[] = [];
    port = 0;
    upgradeMode         : UpgradeMode = "immediate";
    upgradeDelayMs = 0;
    private server      : http.Server | undefined;
    private readonly ws = new WebSocketServer({ noServer: true });
    private readonly timers = new Set<NodeJS.Timeout>();

    private constructor(home: string) {
        this.home = home;
        this.userDataDir = path.join(home, ".config", "google-chrome");
    }

    static async create(): Promise<FakeChrome> {
        const home = await mkdtemp(path.join(os.tmpdir(), "cdm-fake-chrome-"));

        return new FakeChrome(home);
    }

    async reservePort(): Promise<number> {
        const probe = net.createServer();

        await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
        this.port = (probe.address() as AddressInfo).port;
        await new Promise<void>((resolve) => probe.close(() => resolve()));

        return this.port;
    }

    async enable(): Promise<void> {
        const server = http.createServer((_request, response) => {
            response.writeHead(404, { "content-length": "0" });
            response.end();
        });

        server.on("connection", (socket) => {
            this.sockets.add(socket);
            socket.on("end", () => socket.destroy());
            socket.on("close", () => this.sockets.delete(socket));
        });
        server.on("upgrade", (request, socket, head) => {
            this.upgrades.push(request.url ?? "");

            if (this.upgradeMode === "never") return;

            const accept = () => {
                if (socket.destroyed) return;

                this.ws.handleUpgrade(request, socket, head, (client) => {
                    client.on("message", (data) => {
                        const message = JSON.parse(data.toString()) as {
                            id    : number;
                            method: string;
                        };
                        const result =
                            message.method === "Target.getBrowserContexts"
                                ? { browserContextIds: [], defaultBrowserContextId: "DEFAULT" }
                                : {};

                        client.send(JSON.stringify({ id: message.id, result }));
                    });
                });
            };

            if (this.upgradeMode === "delayed") {
                const timer = setTimeout(accept, this.upgradeDelayMs);

                this.timers.add(timer);
            } else {
                accept();
            }
        });
        await new Promise<void>((resolve) => server.listen(this.port, "127.0.0.1", resolve));
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        await mkdir(this.userDataDir, { recursive: true });
        await writeFile(
            path.join(this.userDataDir, "DevToolsActivePort"),
            `${this.port}\n/devtools/browser/fake-id\n`,
        );
    }

    attachContext(): AttachDeps["context"] {
        return { env: {}, platform: "linux", homedir: this.home };
    }

    async stop(): Promise<void> {
        for (const timer of this.timers) clearTimeout(timer);

        for (const socket of this.sockets) socket.destroy();

        for (const client of this.ws.clients) client.terminate();

        await new Promise<void>((resolve) => {
            if (!this.server) return resolve();

            this.server.close(() => resolve());
        });
        await rm(this.home, { recursive: true, force: true });
    }
}
