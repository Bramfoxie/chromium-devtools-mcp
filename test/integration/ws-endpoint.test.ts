import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchManaged, type ManagedBrowser } from "../../src/browser/index.js";
import type { Config } from "../../src/config/index.js";
import { createConnector } from "../../src/daemon/runner.js";
import { chromeAvailable } from "./browser-env.js";

const present = chromeAvailable();
let profile: string;
let browser: ManagedBrowser | undefined;

beforeAll(async () => {
    if (!present) return;

    profile = await mkdtemp(path.join(os.tmpdir(), "cdm-it-ws-"));
    browser = await launchManaged({
        browser   : "chrome",
        headless  : true,
        profileDir: profile,
        debugPort : 0,
    });
});

afterAll(async () => {
    await browser?.stop();

    if (profile) {
        await rm(profile, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
    }
});

describe.skipIf(!present)("attach through an explicit endpoint in a real browser", () => {
    it("connects to the given address and talks to the browser", async () => {
        const config: Config = {
            browser   : "chrome",
            mode      : "attach",
            headless  : false,
            profileDir: profile,
            debugPort : 1,
            wsEndpoint: browser?.webSocketUrl,
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
        const waiting: string[] = [];
        const handle = await createConnector()(
            config,
            { onWaiting: (message) => waiting.push(message) },
            new AbortController().signal,
        );

        try {
            const version = (await handle.client.send("Browser.getVersion")) as { product?: string };

            expect(version.product).toMatch(/Chrome/);
            expect(waiting).toEqual([]);
        } finally {
            await handle.stop();
        }
    });
});
