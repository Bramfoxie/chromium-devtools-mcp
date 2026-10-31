import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CdpClient } from "../../src/cdp/index.js";
import type { Config } from "../../src/config/index.js";
import type { BrowserConnector, DaemonLayout } from "../../src/daemon/index.js";
import { FakeBrowser } from "./fake-browser.js";
import type { createSocketHarness } from "./daemon-socket.js";

type Harness = ReturnType<typeof createSocketHarness>;

export const managedConfig: Config = {
    browser   : "chrome",
    mode      : "managed",
    headless  : true,
    profileDir: "/unused",
    debugPort : 9222,
    allowFocus: false,
    safety    : { readOnly: false, allowedDomains: [], confirmDangerous: false },
};

export async function makeLayout(harness: Harness): Promise<DaemonLayout> {
    const options = await harness.options();
    const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-token-"));

    harness.track(() => rm(dir, { recursive: true, force: true }));

    return {
        tokenFile : path.join(dir, "daemon.token"),
        platform  : options.platform,
        uid       : options.uid,
        socketPath: () => options.socketPath,
        instance  : () => options,
    };
}

export interface RecordedStops {
    count         : number;
    contextsAtStop: number[];
}

export async function startFakeBrowser(harness: Harness) {
    const browser = new FakeBrowser();
    const url = await browser.start();

    harness.track(() => browser.stop());
    const stops = { count: 0 };
    const recorded: RecordedStops = { count: 0, contextsAtStop: [] };
    const connect: BrowserConnector = async () => {
        const client = await CdpClient.connect({ url, requestTimeoutMs: 2000 });

        return {
            client,
            stop: async () => {
                stops.count += 1;
                recorded.count += 1;
                recorded.contextsAtStop.push(browser.contexts.size);
                await client.close();
            },
        };
    };

    return { browser, stops, recorded, connect };
}
