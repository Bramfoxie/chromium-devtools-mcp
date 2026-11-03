import { chmod, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import type { InstanceIO, ListeningServer } from "./lock.js";
import { errorCode } from "./errors.js";
import { logDaemon } from "./log.js";
import { removeStaleLock } from "./stale-lock.js";

const PROBE_TIMEOUT_MS = 1000;

function listenOnSocket(
    path        : string,
    onConnection: (socket: net.Socket) => void,
    restrict    : boolean,
): Promise<ListeningServer> {
    return new Promise((resolve, reject) => {
        const sockets = new Set<net.Socket>();
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on("error", () => undefined);
            socket.once("close", () => sockets.delete(socket));
            onConnection(socket);
        });
        const close = () =>
            new Promise<void>((done) => {
                for (const socket of sockets) socket.destroy();
                server.close(() => done());
            });

        server.once("error", reject);
        server.listen(path, () => {
            server.off("error", reject);
            server.on("error", (error) => {
                logDaemon(`daemon socket error: ${error.message}`);
            });

            if (!restrict) {
                resolve({ close });

                return;
            }

            chmod(path, 0o600).then(
                () => resolve({ close }),
                (error: unknown) => {
                    void close();
                    reject(error);
                },
            );
        });
    });
}

function probeSocket(path: string): Promise<"alive" | "stale"> {
    return new Promise((resolve) => {
        const socket = net.connect(path);
        const finish = (result: "alive" | "stale") => {
            socket.destroy();
            resolve(result);
        };

        socket.setTimeout(PROBE_TIMEOUT_MS, () => finish("alive"));
        socket.once("connect", () => finish("alive"));
        socket.once("error", (error: NodeJS.ErrnoException) => {
            finish(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "stale" : "alive");
        });
    });
}

async function lockCleanup(socketPath: string): Promise<(() => Promise<void>) | undefined> {
    const dir = `${socketPath}.lock`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await mkdir(dir);

            return () => rm(dir, { recursive: true, force: true });
        } catch (error) {
            if (errorCode(error) !== "EEXIST") throw error;

            if (!(await removeStaleLock(dir, Date.now))) return undefined;
        }
    }

    return undefined;
}

export const realInstanceIO: InstanceIO = {
    listen      : listenOnSocket,
    probe       : probeSocket,
    removeSocket: (path) => rm(path, { force: true }),
    lockCleanup,
    sleep       : (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
