import { afterEach, describe, expect, it, vi } from "vitest";
import { connectToDaemon, DaemonConfigMismatchError, daemonIdentity, type DaemonLayout, runDaemon, type RunningDaemon } from "../src/daemon/index.js";
import { type BrowserConnector } from "../src/daemon/runner.js";
import { DaemonLink, DaemonNotReadyError, type LinkDeps } from "../src/mcp/index.js";
import { makeLayout, managedConfig, startFakeBrowser } from "./helpers/daemon-env.js";
import { createSocketHarness } from "./helpers/daemon-socket.js";

const harness = createSocketHarness();

afterEach(async () => {
    await harness.dispose();
    vi.restoreAllMocks();
});

function inProcessDaemon(layout: DaemonLayout, connectBrowser: BrowserConnector) {
    const started: RunningDaemon[] = [];
    const calls = { count: 0 };
    const startDaemon: LinkDeps["startDaemon"] = async () => {
        calls.count += 1;
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const running = await runDaemon(managedConfig, {
            layout,
            connectBrowser,
            idleTimeoutMs: 60_000,
        }).catch(() => undefined);

        if (running) {
            started.push(running);
            harness.track(async () => void (await running.stop()));
        }

        return { exited: running ? running.done.then(() => undefined) : Promise.resolve() };
    };

    return { started, calls, startDaemon };
}

function makeLink(
    layout     : DaemonLayout,
    startDaemon: LinkDeps["startDaemon"],
    mode       : "attach" | "managed" = "managed",
) {
    const link = new DaemonLink(
        { identity: daemonIdentity({ ...managedConfig, mode }) },
        {
            connect       : (expect) => connectToDaemon({ clientName: "mcp-test", expect, layout }),
            startDaemon,
            sleep         : (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            now           : () => Date.now(),
            logFile       : "/data/daemon.log",
            startTimeoutMs: 5000,
            pollIntervalMs: 20,
        },
    );

    harness.track(() => link.close());

    return link;
}

describe("link to a real daemon", () => {
    it("starts the daemon when it is absent, serves requests and cleans up on close", async () => {
        const layout = await makeLayout(harness);
        const { browser, connect } = await startFakeBrowser(harness);
        const { started, startDaemon } = inProcessDaemon(layout, connect);
        const link = makeLink(layout, startDaemon);
        const { targetId } = (await link.request("tab.create", { url: "https://a.example/" })) as {
            targetId: string;
        };

        expect(started).toHaveLength(1);
        expect(browser.targets.get(targetId)?.url).toBe("https://a.example/");
        await link.close();
        await vi.waitFor(() => expect(browser.targets.has(targetId)).toBe(false));
    });

    it("reuses a daemon that is already running", async () => {
        const layout = await makeLayout(harness);
        const { connect } = await startFakeBrowser(harness);
        const { started, calls, startDaemon } = inProcessDaemon(layout, connect);
        const first = makeLink(layout, startDaemon);

        await first.request("tab.list");
        const second = makeLink(layout, startDaemon);

        await second.request("tab.list");
        expect(started).toHaveLength(1);
        expect(calls.count).toBe(1);
    });

    it("keeps the sessions of two links apart", async () => {
        const layout = await makeLayout(harness);
        const { connect } = await startFakeBrowser(harness);
        const { startDaemon } = inProcessDaemon(layout, connect);
        const first = makeLink(layout, startDaemon);
        const second = makeLink(layout, startDaemon);
        const { targetId } = (await first.request("tab.create")) as { targetId: string };

        await expect(second.request("tab.close", { targetId })).rejects.toMatchObject({
            code: "not_owned",
        });
    });

    it("refuses a link whose browser mode differs from the running daemon", async () => {
        const layout = await makeLayout(harness);
        const { connect } = await startFakeBrowser(harness);
        const { started, calls, startDaemon } = inProcessDaemon(layout, connect);

        await makeLink(layout, startDaemon).request("tab.list");
        const other = makeLink(layout, startDaemon, "attach");

        await expect(other.request("tab.list")).rejects.toBeInstanceOf(DaemonConfigMismatchError);
        expect(started).toHaveLength(1);
        expect(calls.count).toBe(1);
    });

    it("recovers on the next request after the daemon went away", async () => {
        const layout = await makeLayout(harness);
        const { connect } = await startFakeBrowser(harness);
        const { started, startDaemon } = inProcessDaemon(layout, connect);
        const link = makeLink(layout, startDaemon);

        await link.request("tab.list");
        await started[0]?.stop();
        await vi.waitFor(
            async () => {
                await expect(link.request("tab.list")).resolves.toBeDefined();
            },
            { timeout: 10_000 },
        );
        expect(started.length).toBeGreaterThanOrEqual(2);
    });

    it("hands the setup instructions to the caller while the browser is not enabled", async () => {
        const layout = await makeLayout(harness);
        const { connect } = await startFakeBrowser(harness);
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const waiting: BrowserConnector = async (config, hooks, signal) => {
            hooks.onWaiting("Open chrome://inspect/#remote-debugging and enable it.");
            await gate;

            return connect(config, hooks, signal);
        };
        const { startDaemon } = inProcessDaemon(layout, waiting);
        const link = makeLink(layout, startDaemon);
        const failure = await link.request("tab.list").catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(DaemonNotReadyError);
        expect((failure as Error).message).toContain("chrome://inspect");
        release();
        await vi.waitFor(
            async () => {
                await expect(link.request("tab.list")).resolves.toEqual({ tabs: [] });
            },
            { timeout: 10_000 },
        );
    });
});
