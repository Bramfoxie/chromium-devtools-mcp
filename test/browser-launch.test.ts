import { afterEach, describe, expect, it, vi } from "vitest";
import {
    BrowserLaunchError,
    BrowserNotFoundError,
    buildLaunchArgs,
    type ChildHandle,
    launchManaged,
    type LaunchDeps,
    type ManagedConfig,
    parseListeningUrl,
} from "../src/browser/index.js";
import { spawnProcess } from "../src/browser/launch.js";

const config: ManagedConfig = {
    browser   : "chrome",
    headless  : false,
    profileDir: "/data/profile",
    debugPort : 9222,
};

const listening = "DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc-123\n";

class FakeChild implements ChildHandle {
    signals               : string[] = [];
    detached = false;
    private stderrHandlers: Array<(chunk: string) => void> = [];
    private exitHandlers  : Array<(reason: string) => void> = [];
    private errorHandlers : Array<(message: string) => void> = [];

    constructor(private readonly dieOn: string[] = ["SIGTERM", "SIGKILL"]) {}

    kill(signal: "SIGTERM" | "SIGKILL"): boolean {
        this.signals.push(signal);
        if (this.dieOn.includes(signal)) this.exit(`terminated by ${signal}`);

        return true;
    }

    detach(): void {
        this.detached = true;
    }

    onStderr(handler: (chunk: string) => void): void {
        this.stderrHandlers.push(handler);
    }

    onExit(handler: (reason: string) => void): void {
        this.exitHandlers.push(handler);
    }

    onError(handler: (message: string) => void): void {
        this.errorHandlers.push(handler);
    }

    fail(message: string): void {
        for (const handler of this.errorHandlers) handler(message);
    }

    write(chunk: string): void {
        for (const handler of this.stderrHandlers) handler(chunk);
    }

    exit(reason: string): void {
        for (const handler of this.exitHandlers) handler(reason);
    }
}

function harness(child = new FakeChild(), overrides: Partial<LaunchDeps> = {}) {
    const spawned: Array<{ command: string; args: string[] }> = [];
    const deps: Partial<LaunchDeps> = {
        findExecutable: () => "/bin/browser",
        spawn         : (command, args) => {
            spawned.push({ command, args });

            return child;
        },
        startTimeoutMs: 1000,
        stopGraceMs   : 20,
        ...overrides,
    };

    return { deps, spawned, child };
}

afterEach(() => {
    vi.useRealTimers();
});

describe("buildLaunchArgs", () => {
    it("passes the port and the profile directory", () => {
        const args = buildLaunchArgs(config);

        expect(args).toContain("--remote-debugging-port=9222");
        expect(args).toContain("--user-data-dir=/data/profile");
        expect(args).not.toContain("--headless=new");
    });

    it("adds the headless flag when configured", () => {
        expect(buildLaunchArgs({ ...config, headless: true })).toContain("--headless=new");
    });
});

describe("parseListeningUrl", () => {
    it("extracts the endpoint from the browser output", () => {
        expect(parseListeningUrl(`noise\n${listening}more`)).toEqual({
            port        : 9222,
            webSocketUrl: "ws://127.0.0.1:9222/devtools/browser/abc-123",
        });
    });

    it.each(["", "DevTools listening on", "DevTools listening on ws://host/path", "unrelated"])(
        "returns undefined for %j",
        (output) => {
            expect(parseListeningUrl(output)).toBeUndefined();
        },
    );
});

describe("launchManaged", () => {
    it("spawns the resolved executable and resolves with the endpoint", async () => {
        const { deps, spawned, child } = harness();
        const pending = launchManaged(config, deps);

        child.write(listening);
        await expect(pending).resolves.toMatchObject({
            port        : 9222,
            webSocketUrl: "ws://127.0.0.1:9222/devtools/browser/abc-123",
        });
        expect(spawned).toEqual([
            {
                command: "/bin/browser",
                args   : [
                    "--remote-debugging-port=9222",
                    "--user-data-dir=/data/profile",
                    "--no-first-run",
                    "--no-default-browser-check",
                ],
            },
        ]);
    });

    it("assembles the endpoint from split output chunks", async () => {
        const { deps, child } = harness();
        const pending = launchManaged(config, deps);

        child.write("DevTools listening on ws://127.0.0.1:92");
        child.write("22/devtools/browser/abc-123\n");
        await expect(pending).resolves.toMatchObject({ port: 9222 });
    });

    it("ignores unrelated output before the endpoint line", async () => {
        const { deps, child } = harness();
        const pending = launchManaged(config, deps);

        child.write("ERROR: display link failed\n");
        child.write(listening);
        await expect(pending).resolves.toMatchObject({ port: 9222 });
    });

    it("fails with the profile and port hint when the browser exits early", async () => {
        const { deps, child } = harness();
        const pending = launchManaged(config, deps);

        child.exit("exited with code 0");
        const failure = await pending.catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(BrowserLaunchError);
        expect((failure as Error).message).toContain("exited with code 0");
        expect((failure as Error).message).toContain("/data/profile");
        expect((failure as Error).message).toContain("9222");
    });

    it("times out, stops the browser and names the profile and port", async () => {
        const { deps, child } = harness(new FakeChild(), { startTimeoutMs: 30 });
        const failure = await launchManaged(config, deps).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(BrowserLaunchError);
        expect((failure as Error).message).toContain("within 30 ms");
        expect((failure as Error).message).toContain("port 9222");
        expect(child.signals).toEqual(["SIGTERM"]);
    });

    it("rejects with BrowserNotFoundError from discovery without spawning", async () => {
        const { deps, spawned } = harness(new FakeChild(), {
            findExecutable: () => {
                throw new BrowserNotFoundError("missing");
            },
        });

        await expect(launchManaged(config, deps)).rejects.toBeInstanceOf(BrowserNotFoundError);
        expect(spawned).toEqual([]);
    });

    it("wraps a synchronous spawn failure in BrowserLaunchError", async () => {
        const { deps } = harness(new FakeChild(), {
            spawn: () => {
                throw new Error("spawn exploded");
            },
        });
        const failure = await launchManaged(config, deps).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(BrowserLaunchError);
        expect((failure as Error).message).toContain("spawn exploded");
    });

    it("reports a spawn error without the profile hint", async () => {
        const { deps, child } = harness();
        const pending = launchManaged(config, deps);

        child.fail("spawn /bin/browser ENOENT");
        const failure = await pending.catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(BrowserLaunchError);
        expect((failure as Error).message).toContain("failed to start /bin/browser");
        expect((failure as Error).message).not.toContain("profile");
    });

    it("passes the headless flag to the spawned browser", async () => {
        const { deps, spawned, child } = harness();
        const pending = launchManaged({ ...config, headless: true }, deps);

        child.write(listening);
        await pending;
        expect(spawned[0]?.args).toContain("--headless=new");
    });

    it("keeps a profile directory with spaces and a leading dash as one argument", async () => {
        const { deps, spawned, child } = harness();
        const pending = launchManaged({ ...config, profileDir: "--evil dir" }, deps);

        child.write(listening);
        await pending;
        expect(spawned[0]?.args).toContain("--user-data-dir=--evil dir");
        expect(spawned[0]?.args.filter((arg) => arg.startsWith("--user-data-dir"))).toHaveLength(1);
    });

    it("accepts CRLF line endings and IPv6 hosts", async () => {
        const { deps, child } = harness();
        const pending = launchManaged(config, deps);

        child.write("DevTools listening on ws://[::1]:9222/devtools/browser/v6\r\n");
        await expect(pending).resolves.toMatchObject({
            port        : 9222,
            webSocketUrl: "ws://[::1]:9222/devtools/browser/v6",
        });
    });

    it("uses the first endpoint line when several are printed", async () => {
        const { deps, child } = harness();
        const pending = launchManaged(config, deps);

        child.write(`${listening}DevTools listening on ws://127.0.0.1:1/devtools/browser/other\n`);
        await expect(pending).resolves.toMatchObject({ port: 9222 });
    });

    it("does not resolve from a partial line without a line break", async () => {
        const { deps, child } = harness(new FakeChild(), { startTimeoutMs: 30 });
        const pending = launchManaged(config, deps);

        child.write("DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc");
        await expect(pending).rejects.toBeInstanceOf(BrowserLaunchError);
    });

    it("reports early exit by signal and by non-zero code", async () => {
        for (const reason of ["terminated by SIGKILL", "exited with code 1"]) {
            const { deps, child } = harness();
            const pending = launchManaged(config, deps);

            child.exit(reason);
            await expect(pending).rejects.toThrow(reason);
        }
    });

    it("escalates to SIGKILL when a hung browser ignores SIGTERM at timeout", async () => {
        const child = new FakeChild(["SIGKILL"]);
        const { deps } = harness(child, { startTimeoutMs: 30 });

        await expect(launchManaged(config, deps)).rejects.toBeInstanceOf(BrowserLaunchError);
        expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    });

    it("leaves no timers behind after a successful start", async () => {
        vi.useFakeTimers();
        const { deps, child } = harness();
        const pending = launchManaged(config, deps);

        child.write(listening);
        await pending;
        expect(vi.getTimerCount()).toBe(0);
    });

    it("leaves no timers behind after an early exit", async () => {
        vi.useFakeTimers();
        const { deps, child } = harness();
        const pending = launchManaged(config, deps);

        child.exit("exited with code 0");
        await pending.catch(() => undefined);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("stop", () => {
    async function started(child: FakeChild) {
        const { deps } = harness(child);
        const pending = launchManaged(config, deps);

        child.write(listening);

        return pending;
    }

    it("terminates the browser with SIGTERM", async () => {
        const child = new FakeChild();
        const browser = await started(child);

        await browser.stop();
        expect(child.signals).toEqual(["SIGTERM"]);
    });

    it("detaches from the browser on release without signalling it", async () => {
        const child = new FakeChild();
        const browser = await started(child);

        browser.release();
        expect(child.detached).toBe(true);
        expect(child.signals).toEqual([]);
    });

    it("escalates to SIGKILL when SIGTERM is ignored", async () => {
        const child = new FakeChild(["SIGKILL"]);
        const browser = await started(child);

        await browser.stop();
        expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    });

    it("sends signals once for concurrent stop calls", async () => {
        const child = new FakeChild(["SIGKILL"]);
        const browser = await started(child);

        await Promise.all([browser.stop(), browser.stop()]);
        expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    });

    it("leaves no timers behind after stop", async () => {
        const child = new FakeChild();
        const browser = await started(child);

        vi.useFakeTimers();
        await browser.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("still stops the browser after an error event following a successful start", async () => {
        const child = new FakeChild();
        const browser = await started(child);

        child.fail("kill EPERM");
        await browser.stop();
        expect(child.signals).toEqual(["SIGTERM"]);
    });

    it("gives up waiting when SIGKILL does not end the process", async () => {
        const child = new FakeChild([]);
        const browser = await started(child);

        await browser.stop();
        expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    });

    it("does nothing when the browser already exited", async () => {
        const child = new FakeChild();
        const browser = await started(child);

        child.exit("exited with code 0");
        await browser.stop();
        expect(child.signals).toEqual([]);
    });
});

describe("spawnProcess", () => {
    function collect(command: string, args: string[]) {
        const child = spawnProcess(command, args);
        const result = {
            stderr: "",
            exit  : undefined as string | undefined,
            error : undefined as string | undefined,
        };

        child.onStderr((chunk) => (result.stderr += chunk));
        child.onExit((reason) => (result.exit = reason));
        child.onError((message) => (result.error = message));

        return { child, result };
    }

    it("streams stderr and reports a clean exit", async () => {
        const { result } = collect(process.execPath, ["-e", "console.error('hello stderr')"]);

        await vi.waitFor(() => expect(result.exit).toBeDefined());
        expect(result.stderr).toContain("hello stderr");
        expect(result.exit).toBe("exited with code 0");
    });

    it("reports a missing executable through onError", async () => {
        const { result } = collect("/definitely/not/a/browser", []);

        await vi.waitFor(() => expect(result.error).toBeDefined());
        expect(result.error).toContain("ENOENT");
    });

    it("reports termination after kill", async () => {
        const { child, result } = collect(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);

        child.kill("SIGTERM");
        await vi.waitFor(() => expect(result.exit).toBeDefined());
        expect(result.exit).toMatch(/terminated by SIGTERM|exited with code/);
    });
});
