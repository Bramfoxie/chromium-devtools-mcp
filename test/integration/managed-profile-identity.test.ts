import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { launchManaged, type ManagedBrowser } from "../../src/browser/index.js";
import { CdpClient } from "../../src/cdp/index.js";
import { createConnector, type BrowserHandle } from "../../src/daemon/runner.js";
import { findManagedBrowser } from "../../src/daemon/managed-binding.js";
import { chromeAvailable } from "./browser-env.js";

async function freePort(): Promise<number> {
    const server = createServer();

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    if (address === null || typeof address === "string") throw new Error("No listening port.");

    await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));

    return address.port;
}

describe.skipIf(!chromeAvailable())("managed browser profile identity", () => {
    it.each(["random", "fixed"])("reuses its own browser with a %s port", async (kind) => {
        const root = await mkdtemp(path.join(os.tmpdir(), "cdm-profile-reuse-"));
        const profile = path.join(root, "profile");
        const config = {
            browser   : "chrome" as const, mode      : "managed" as const, headless  : true,
            profileDir: profile, debugPort : kind === "fixed" ? await freePort() : 0,
            allowFocus: false, isolated  : false,
            safety    : {
                readOnly            : false, allowedDomains      : [], deniedDomains       : [],
                allowPrivateNetworks: true, confirmDangerous    : false, uploadDirs          : [],
            },
        };
        const hooks = {
            onWaiting     : () => undefined,
            managedBinding: {
                directory: path.join(root, "private"), platform: process.platform, uid: process.getuid?.(),
            },
        };
        const connector = createConnector();
        let first: BrowserHandle | undefined;
        let second: BrowserHandle | undefined;

        try {
            first = await connector(config, hooks, new AbortController().signal);
            const before = await first.client.send("SystemInfo.getProcessInfo") as {
                processInfo: Array<{ type: string; id: number }>;
            };

            second = await connector(config, hooks, new AbortController().signal);
            const after = await second.client.send("SystemInfo.getProcessInfo") as {
                processInfo: Array<{ type: string; id: number }>;
            };

            expect(after.processInfo.find((info) => info.type === "browser")?.id)
                .toBe(before.processInfo.find((info) => info.type === "browser")?.id);
        } finally {
            await second?.stop();
            await first?.stop();
            await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
        }
    });

    it("does not reuse a browser from a copied DevToolsActivePort file", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "cdm-profile-copy-"));
        const first = path.join(root, "first");
        const second = path.join(root, "second");
        let browser: ManagedBrowser | undefined;

        try {
            await mkdir(second);
            browser = await launchManaged({ browser: "chrome", headless: true, profileDir: first, debugPort: 0 });
            const endpoint = new URL(browser.webSocketUrl);

            await writeFile(path.join(first, "DevToolsActivePort"), `${endpoint.port}\n${endpoint.pathname}\n`);
            await copyFile(path.join(first, "DevToolsActivePort"), path.join(second, "DevToolsActivePort"));
            expect(await findManagedBrowser(second, { browser: "chrome", headless: true }, {
                directory: path.join(root, "private"), platform: process.platform, uid: process.getuid?.(),
            })).toBeUndefined();
        } finally {
            await browser?.stop();
            await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
        }
    });

    it("does not identify another browser by its port", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "cdm-profile-identity-"));
        const firstDir = path.join(root, "first");
        const secondDir = path.join(root, "second");
        let first: ManagedBrowser | undefined;
        let second: ManagedBrowser | undefined;
        let client: CdpClient | undefined;

        try {
            first = await launchManaged({ browser: "chrome", headless: true, profileDir: firstDir, debugPort: await freePort() });
            second = await launchManaged({ browser: "chrome", headless: true, profileDir: secondDir, debugPort: 0 });
            await rm(path.join(firstDir, "DevToolsActivePort"), { force: true });
            client = await CdpClient.connect({ url: second.webSocketUrl });
            const created = await client.send("Target.createTarget", { url: "about:blank" }) as {
                targetId: string;
            };
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15_000);

            try {
                await expect(createConnector()({
                    browser   : "chrome", mode      : "managed", headless  : true,
                    profileDir: firstDir, debugPort : second.port,
                    allowFocus: false, isolated  : false,
                    safety    : {
                        readOnly            : false,
                        allowedDomains      : [],
                        deniedDomains       : [],
                        allowPrivateNetworks: true,
                        confirmDangerous    : false,
                        uploadDirs          : [],
                    },
                }, {
                    onWaiting     : () => undefined,
                    managedBinding: {
                        directory: path.join(root, "private"),
                        platform : process.platform,
                        uid      : process.getuid?.(),
                    },
                }, controller.signal)).rejects.toThrow();
            } finally {
                clearTimeout(timer);
            }

            const targets = await client.send("Target.getTargets") as {
                targetInfos: Array<{ targetId: string }>;
            };

            expect(targets.targetInfos.some((target) => target.targetId === created.targetId))
                .toBe(true);
        } finally {
            await client?.close();
            await first?.stop();
            await second?.stop();
            await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
        }
    });
});
