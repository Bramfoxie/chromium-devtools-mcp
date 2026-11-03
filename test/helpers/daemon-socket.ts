import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { InstanceOptions } from "../../src/daemon/index.js";

export function createSocketHarness() {
    const cleanups: Array<() => Promise<void>> = [];
    const track = (cleanup: () => Promise<void>) => {
        cleanups.push(cleanup);
    };

    return {
        track,
        async options(): Promise<InstanceOptions> {
            if (process.platform === "win32") {
                const socketPath = `\\\\.\\pipe\\cdm-test-${randomBytes(6).toString("hex")}`;

                return { socketPath, runtimeDir: undefined, platform: "win32", uid: undefined };
            }

            const base = await mkdtemp(path.join(os.tmpdir(), "cdm-"));

            track(() => rm(base, { recursive: true, force: true }));
            const dir = path.join(base, "run");

            return {
                socketPath: path.join(dir, "daemon.sock"),
                runtimeDir: dir,
                platform  : process.platform,
                uid       : process.getuid?.(),
            };
        },
        async dispose(): Promise<void> {
            for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
        },
    };
}
