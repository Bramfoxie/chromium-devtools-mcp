import { describe, expect, it } from "vitest";
import { runDaemonControl, type DaemonControlDeps } from "../src/cli-daemon.js";
import {
    DaemonError,
    DaemonNotRunningError,
    type IpcClient,
    IpcClosedError,
} from "../src/daemon/index.js";

const identity = { browser: "chrome", mode: "attach", debugPort: 9222, allowFocus: false };

class FakeClient {
    readonly requests: string[] = [];
    closed = false;

    constructor(
        private readonly handler: (method: string) => unknown = () => ({}),
        readonly helloResult    : unknown = { daemon: identity },
    ) {}

    async request(method: string): Promise<unknown> {
        this.requests.push(method);

        return this.handler(method);
    }

    async close(): Promise<void> {
        this.closed = true;
    }
}

function setup(overrides: Partial<DaemonControlDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    let time = 0;
    const deps: DaemonControlDeps = {
        connect: async () => {
            throw new DaemonNotRunningError();
        },
        logFile: "/data/daemon.log",
        readLog: () => undefined,
        out    : (text) => void out.push(text),
        err    : (text) => void err.push(text),
        sleep  : async (ms) => void (time += ms),
        now    : () => time,
        ...overrides,
    };

    return { deps, out: () => out.join(""), err: () => err.join("") };
}

const asClient = (client: FakeClient) => client as unknown as IpcClient;

describe("daemon status", () => {
    it("prints the state, the browser, the settings and the log file", async () => {
        const client = new FakeClient(() => ({ state: "ready", browser: "chrome", mode: "attach" }));
        const { deps, out } = setup({ connect: async () => asClient(client) });

        expect(await runDaemonControl("status", [], deps)).toBe(0);
        expect(out()).toContain("The daemon is running (ready).");
        expect(out()).toContain("Browser: chrome, mode attach");
        expect(out()).toContain("Settings: browser chrome, mode attach, debugPort 9222, allowFocus false\n");
        expect(out()).toContain("Log: /data/daemon.log");
        expect(client.requests).toEqual(["daemon.status"]);
        expect(client.closed).toBe(true);
    });

    it("prints the waiting message of the daemon", async () => {
        const client = new FakeClient(() => ({
            state  : "waiting",
            browser: "chrome",
            mode   : "attach",
            message: "Waiting until remote debugging is enabled.",
        }));
        const { deps, out } = setup({ connect: async () => asClient(client) });

        await runDaemonControl("status", [], deps);

        expect(out()).toContain("The daemon is running (waiting).");
        expect(out()).toContain("Message: Waiting until remote debugging is enabled.");
    });

    it.each([new DaemonNotRunningError(), new IpcClosedError("the daemon closed the connection")])(
        "says the daemon is not running and exits with 1 (%s)",
        async (failure) => {
            const { deps, out } = setup({
                connect: async () => {
                    throw failure;
                },
            });

            expect(await runDaemonControl("status", [], deps)).toBe(1);
            expect(out()).toBe("The daemon is not running.\n");
        },
    );

    it("reports any other connection failure", async () => {
        const { deps, err } = setup({
            connect: async () => {
                throw new DaemonError("Cannot read the daemon token file.");
            },
        });

        expect(await runDaemonControl("status", [], deps)).toBe(1);
        expect(err()).toBe("Cannot read the daemon token file.\n");
    });

    it("reports a status answer it does not understand", async () => {
        const client = new FakeClient(() => ({ state: 5 }));
        const { deps, err } = setup({ connect: async () => asClient(client) });

        expect(await runDaemonControl("status", [], deps)).toBe(1);
        expect(err()).toContain("unexpected result");
        expect(client.closed).toBe(true);
    });

    it("refuses arguments", async () => {
        const { deps, err } = setup();

        expect(await runDaemonControl("status", ["--now"], deps)).toBe(2);
        expect(err()).toContain("Usage: chromium-devtools-mcp daemon status");
    });
});

describe("daemon stop", () => {
    it("succeeds when the daemon is not running", async () => {
        const { deps, out } = setup();

        expect(await runDaemonControl("stop", [], deps)).toBe(0);
        expect(out()).toBe("The daemon is not running.\n");
    });

    it("asks the daemon to stop and waits until it is gone", async () => {
        const first = new FakeClient();
        let connections = 0;
        const { deps, out } = setup({
            connect: async () => {
                connections += 1;

                if (connections <= 2) return asClient(connections === 1 ? first : new FakeClient());

                throw new DaemonNotRunningError();
            },
        });

        expect(await runDaemonControl("stop", [], deps)).toBe(0);
        expect(first.requests).toEqual(["daemon.stop"]);
        expect(first.closed).toBe(true);
        expect(connections).toBe(3);
        expect(out()).toBe("The daemon stopped.\n");
    });

    it("accepts a connection that closes while answering", async () => {
        let connections = 0;
        const { deps, out } = setup({
            connect: async () => {
                connections += 1;

                if (connections === 1) {
                    return asClient(
                        new FakeClient(() => {
                            throw new IpcClosedError("the daemon closed the connection");
                        }),
                    );
                }

                throw new DaemonNotRunningError();
            },
        });

        expect(await runDaemonControl("stop", [], deps)).toBe(0);
        expect(out()).toBe("The daemon stopped.\n");
    });

    it("fails when the daemon keeps running", async () => {
        const { deps, err } = setup({
            connect   : async () => asClient(new FakeClient()),
            stopWaitMs: 1000,
        });

        expect(await runDaemonControl("stop", [], deps)).toBe(1);
        expect(err()).toBe("The daemon did not stop in time. See /data/daemon.log for its messages.\n");
    });
});

describe("daemon logs", () => {
    const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);

    it("prints the last 100 lines by default", async () => {
        const { deps, out } = setup({ readLog: () => `${lines(150).join("\n")}\n` });

        expect(await runDaemonControl("logs", [], deps)).toBe(0);

        const printed = out().trimEnd().split("\n");

        expect(printed).toHaveLength(100);
        expect(printed[0]).toBe("line 51");
        expect(printed.at(-1)).toBe("line 150");
    });

    it("honors --lines and handles a short or Windows style file", async () => {
        const { deps, out } = setup({ readLog: () => lines(5).join("\r\n") });

        await runDaemonControl("logs", ["--lines", "2"], deps);
        expect(out()).toBe("line 4\nline 5\n");
    });

    it("says when there is no log yet", async () => {
        const { deps, out } = setup();

        expect(await runDaemonControl("logs", [], deps)).toBe(0);
        expect(out()).toBe("There is no daemon log yet at /data/daemon.log.\n");
    });

    it.each([["--lines", "0"], ["--lines", "abc"], ["--lines", "10001"], ["--lines"], ["--tail"], ["x"]])(
        "rejects the arguments %j",
        async (...argv) => {
            const { deps, err } = setup({ readLog: () => "a\n" });

            expect(await runDaemonControl("logs", argv, deps)).toBe(2);
            expect(err()).not.toBe("");
        },
    );

    it("reports a log that cannot be read", async () => {
        const { deps, err } = setup({
            readLog: () => {
                throw new Error("EACCES: permission denied");
            },
        });

        expect(await runDaemonControl("logs", [], deps)).toBe(1);
        expect(err()).toBe("EACCES: permission denied\n");
    });
});
