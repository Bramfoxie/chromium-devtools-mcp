import { closeSync, constants, fstatSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { logDaemon } from "../util/log.js";

export interface TrafficEntry {
    direction: "sent" | "received";
    method?  : string;
    id?      : number;
    bytes    : number;
}

export type TrafficObserver = (entry: TrafficEntry) => void;

export interface TrafficFileIO {
    platform: NodeJS.Platform;
    open(file: string): number;
    stat(fd: number): { isFile(): boolean; mode: number };
    write(fd: number, line: string): void;
    close(fd: number): void;
    warn(message: string): void;
}

const nodeIO: TrafficFileIO = {
    platform: process.platform,
    open    : (file) => {
        try {
            if (!lstatSync(file).isFile()) throw new Error("not a regular file");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        return openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND |
            (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
    },
    stat : fstatSync,
    write: (fd, line) => { writeFileSync(fd, line); },
    close: closeSync,
    warn : logDaemon,
};

export function trafficFile(file: string, io: TrafficFileIO = nodeIO): TrafficObserver {
    let failed = false;
    const fail = () => {
        if (failed) return;

        failed = true;
        io.warn("could not write the CDP log; check the file and its permissions");
    };

    return (entry) => {
        if (failed) return;

        let fd: number | undefined;

        try {
            fd = io.open(file);
            const stat = io.stat(fd);

            if (!stat.isFile() || (io.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
                throw new Error("the file is not private or is not a regular file");
            }

            const method = entry.method !== undefined && /^[A-Za-z][A-Za-z0-9]{0,63}\.[A-Za-z][A-Za-z0-9]{0,63}$/.test(entry.method)
                ? entry.method
                : undefined;
            const id = entry.id !== undefined && Number.isSafeInteger(entry.id) && entry.id >= 0
                ? entry.id
                : undefined;

            io.write(fd, `${JSON.stringify({ direction: entry.direction, method, id, bytes: entry.bytes })}\n`);
        } catch {
            fail();
        } finally {
            if (fd !== undefined) {
                try {
                    io.close(fd);
                } catch {
                    fail();
                }
            }
        }
    };
}
