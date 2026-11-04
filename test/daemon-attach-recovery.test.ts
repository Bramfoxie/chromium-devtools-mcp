import { afterEach, describe, expect, it, vi } from "vitest";
import { attachBrowser } from "../src/browser/attach.js";
import type { Config } from "../src/config/index.js";
import { connectToDaemon, runDaemon, type RunningDaemon } from "../src/daemon/index.js";
import { approvalMessage, type BrowserConnector, createConnector } from "../src/daemon/runner.js";
import { makeLayout } from "./helpers/daemon-env.js";
import { createSocketHarness } from "./helpers/daemon-socket.js";
import { FakeChrome } from "./helpers/fake-chrome.js";

const harness = createSocketHarness();
const chromes: FakeChrome[] = [];

afterEach(async () => {
    await harness.dispose();
    await Promise.all(chromes.splice(0).map((chrome) => chrome.stop()));
    vi.restoreAllMocks();
});

function attachConfig(debugPort: number): Config {
    return {
        browser   : "chrome",
        mode      : "attach",
        headless  : false,
        profileDir: "/unused",
        debugPort,
        allowFocus: false,
        isolated  : false,
        safety    : { readOnly: false, allowedDomains: [], confirmDangerous: false },
    };
}

async function newChrome(): Promise<FakeChrome> {
    const chrome = await FakeChrome.create();

    chromes.push(chrome);
    await chrome.reservePort();

    return chrome;
}

function connectorFor(chrome: FakeChrome, handshakeMs: number): BrowserConnector {
    return createConnector({
        attach: (config, overrides, signal) =>
            attachBrowser(
                config,
                {
                    context       : chrome.attachContext(),
                    pollIntervalMs: 20,
                    log           : () => undefined,
                    ...overrides,
                },
                signal,
            ),
        handshakeMs,
        retryMs: 20,
    });
}

function captureLog(): string[] {
    const lines: string[] = [];

    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        lines.push(String(chunk));

        return true;
    });

    return lines;
}

async function waitForClosedSockets(chrome: FakeChrome): Promise<void> {
    await vi.waitFor(() => expect(chrome.sockets.size).toBe(0), { timeout: 3000 });
}

describe("attach connector phases", () => {
    it("picks up an endpoint that appears after waiting started and connects", async () => {
        const chrome = await newChrome();
        const messages: string[] = [];
        const controller = new AbortController();
        const connect = connectorFor(chrome, 2000);
        const pending = connect(
            attachConfig(chrome.port),
            { onWaiting: (message) => messages.push(message) },
            controller.signal,
        );

        await vi.waitFor(() => expect(messages).toHaveLength(1));
        expect(messages[0]).toContain("remote debugging is not enabled");
        await chrome.enable();
        const handle = await pending;

        expect(messages.at(-1)).toBe(approvalMessage());
        await handle.stop();
    });

    it("abandons a handshake that the server never answers and retries on a new socket", async () => {
        const lines = captureLog();
        const chrome = await newChrome();

        chrome.upgradeMode = "never";
        await chrome.enable();
        const controller = new AbortController();
        const pending = connectorFor(chrome, 150)(
            attachConfig(chrome.port),
            { onWaiting: () => undefined },
            controller.signal,
        );

        await vi.waitFor(() => expect(chrome.upgrades.length).toBeGreaterThanOrEqual(3), {
            timeout: 5000,
        });
        expect(lines.join("")).toContain("could not connect to the browser yet, retrying");
        controller.abort();
        await expect(pending).rejects.toThrow();
        await waitForClosedSockets(chrome);
    });

    it("connects when the server completes the upgrade within the budget", async () => {
        const chrome = await newChrome();

        chrome.upgradeMode = "delayed";
        chrome.upgradeDelayMs = 150;
        await chrome.enable();
        const handle = await connectorFor(chrome, 2000)(
            attachConfig(chrome.port),
            { onWaiting: () => undefined },
            new AbortController().signal,
        );

        expect(chrome.upgrades).toHaveLength(1);
        await handle.stop();
    });

    it("ends the waiting phase on abort without leaving sockets", async () => {
        const chrome = await newChrome();
        const controller = new AbortController();
        const onWaiting = vi.fn();
        const pending = connectorFor(chrome, 2000)(
            attachConfig(chrome.port),
            { onWaiting },
            controller.signal,
        );

        await vi.waitFor(() => expect(onWaiting).toHaveBeenCalledTimes(1));
        controller.abort();
        await expect(pending).rejects.toThrow();
        expect(chrome.sockets.size).toBe(0);
    });

    it("ends the connecting phase on abort and destroys the socket", async () => {
        const chrome = await newChrome();

        chrome.upgradeMode = "never";
        await chrome.enable();
        const controller = new AbortController();
        const pending = connectorFor(chrome, 60_000)(
            attachConfig(chrome.port),
            { onWaiting: () => undefined },
            controller.signal,
        );

        await vi.waitFor(() => expect(chrome.upgrades).toHaveLength(1));
        controller.abort();
        await expect(pending).rejects.toThrow();
        await waitForClosedSockets(chrome);
    });
});

describe("daemon status across the attach phases", () => {
    it("shows the setup, approval and ready messages to clients asking in each phase", async () => {
        const lines = captureLog();
        const chrome = await newChrome();

        chrome.upgradeMode = "delayed";
        chrome.upgradeDelayMs = 400;
        const layout = await makeLayout(harness);
        const daemon: RunningDaemon = await runDaemon(attachConfig(chrome.port), {
            layout,
            connectBrowser: connectorFor(chrome, 5000),
            idleTimeoutMs : 60_000,
        });

        harness.track(async () => void (await daemon.stop()));
        const client = await connectToDaemon({ layout, clientName: "phases" });

        harness.track(() => client.close());

        const status = async () =>
            (await client.request("daemon.status")) as { state: string; message?: string };
        const notReady = async () =>
            client.request("session.open", {}).catch((error: Error) => error.message);

        await vi.waitFor(async () => expect((await status()).state).toBe("waiting"));
        expect((await status()).message).toContain("remote debugging is not enabled");
        expect(await notReady()).toContain("remote debugging is not enabled");

        await chrome.enable();
        await vi.waitFor(async () => expect((await status()).message).toBe(approvalMessage()));
        expect(await notReady()).toBe(approvalMessage());

        await vi.waitFor(async () => expect((await status()).state).toBe("ready"), { timeout: 5000 });
        expect((await status()).message).toBeUndefined();
        await expect(client.request("session.open", {})).resolves.toEqual({ isolated: false });

        const log = lines.join("");

        expect(log).toContain("Connecting to Chrome on port");
        expect(log).toContain("Connected to Chrome on port");
    });
});
