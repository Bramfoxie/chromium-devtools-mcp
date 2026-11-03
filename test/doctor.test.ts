import { describe, expect, it, vi } from "vitest";
import { BrowserNotFoundError } from "../src/browser/index.js";
import type { Config } from "../src/config/index.js";
import { daemonIdentity } from "../src/daemon/index.js";
import {
    type DaemonProbe,
    type DoctorCheck,
    type DoctorDeps,
    formatChecks,
    runDoctor,
} from "../src/doctor.js";

const attach: Config = {
    browser   : "chrome",
    mode      : "attach",
    headless  : false,
    profileDir: "/data/profile",
    debugPort : 9222,
    allowFocus: false,
    isolated  : false,
    safety    : { readOnly: false, allowedDomains: [], confirmDangerous: false },
};
const managed: Config = { ...attach, mode: "managed", debugPort: 0 };

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
    return {
        nodeVersion       : "24.1.0",
        platform          : "linux",
        findBrowser       : () => "/usr/bin/google-chrome",
        findAttachEndpoint: async () => ({
            port        : 9222,
            webSocketUrl: "ws://127.0.0.1:9222/devtools/browser/x",
            source      : "debug-port",
        }),
        isPortOpen : async () => true,
        isWritable : async () => true,
        probeDaemon: async (): Promise<DaemonProbe> => ({ kind: "not-running" }),
        findProgram: async (name) => `/usr/bin/${name}`,
        ...overrides,
    };
}

const levels = (checks: DoctorCheck[]) => checks.map((check) => `${check.level} ${check.title}`);

describe("doctor", () => {
    it("passes for a healthy attach setup", async () => {
        const checks = await runDoctor(attach, deps());

        expect(levels(checks)).toEqual([
            "ok Node.js",
            "ok Settings",
            "ok Browser endpoint",
            "ok Daemon",
            "ok ffmpeg",
            "ok lighthouse",
        ]);
        expect(formatChecks(checks)).toContain("No problems found.");
    });

    it("passes for a healthy managed setup", async () => {
        const checks = await runDoctor(managed, deps());

        expect(levels(checks)).toEqual([
            "ok Node.js",
            "ok Settings",
            "ok Chrome",
            "ok Profile directory",
            "ok Daemon",
            "ok ffmpeg",
            "ok lighthouse",
        ]);
    });

    it("fails on an old Node.js", async () => {
        const [node] = await runDoctor(attach, deps({ nodeVersion: "20.11.0" }));

        expect(node?.level).toBe("fail");
        expect(node?.fix?.[0]).toContain("Node.js 22");
    });

    it("fails when a managed browser is not installed", async () => {
        const checks = await runDoctor(
            managed,
            deps({
                findBrowser: () => {
                    throw new BrowserNotFoundError("Could not find chrome on linux.");
                },
            }),
        );

        expect(checks[2]).toMatchObject({
            level : "fail",
            title : "Chrome",
            detail: "Could not find chrome on linux.",
        });
    });

    it("lets an unexpected browser lookup failure through", async () => {
        await expect(
            runDoctor(
                managed,
                deps({
                    findBrowser: () => {
                        throw new Error("boom");
                    },
                }),
            ),
        ).rejects.toThrow("boom");
    });

    it("fails when the profile directory cannot be written", async () => {
        const checks = await runDoctor(managed, deps({ isWritable: async () => false }));

        expect(checks[3]).toMatchObject({ level: "fail", title: "Profile directory" });
    });

    it("explains how to enable remote debugging when no browser is found", async () => {
        const checks = await runDoctor(attach, deps({ findAttachEndpoint: async () => undefined }));
        const endpoint = checks[2];

        expect(endpoint?.level).toBe("fail");
        expect(endpoint?.detail).toContain("port 9222");
        expect(endpoint?.fix?.join(" ")).toContain("chrome://inspect/#remote-debugging");
    });

    it("probes the port of an explicit endpoint instead of searching", async () => {
        const isPortOpen = vi.fn(async () => false);
        const findAttachEndpoint = vi.fn(async () => undefined);
        const config = { ...attach, wsEndpoint: "ws://127.0.0.1:9444/devtools/browser/abc" };
        const checks = await runDoctor(config, deps({ isPortOpen, findAttachEndpoint }));

        expect(isPortOpen).toHaveBeenCalledWith(9444);
        expect(findAttachEndpoint).not.toHaveBeenCalled();
        expect(checks[1]?.detail).toContain("endpoint ws://127.0.0.1:9444/devtools/browser/abc");
        expect(checks[2]).toMatchObject({ level: "fail", detail: "nothing listens on port 9444" });
        expect(checks[2]?.fix?.join(" ")).toContain("changes every time the browser starts");
    });

    describe("daemon", () => {
        const running = (patch: Partial<Extract<DaemonProbe, { kind: "running" }>> = {}): DaemonProbe => ({
            kind    : "running",
            state   : "ready",
            identity: daemonIdentity(attach),
            ...patch,
        });
        const daemonCheck = async (probe: DaemonProbe, config: Config = attach) =>
            (await runDoctor(config, deps({ probeDaemon: async () => probe }))).find(
                (check) => check.title === "Daemon",
            );

        it("is fine when it runs with the same settings", async () => {
            expect(await daemonCheck(running())).toMatchObject({ level: "ok" });
        });

        it("warns about settings that differ from the config", async () => {
            const check = await daemonCheck(running(), { ...attach, debugPort: 9333 });

            expect(check?.level).toBe("warn");
            expect(check?.detail).toContain("debugPort 9222");
            expect(check?.fix?.[0]).toContain("daemon stop");
        });

        it("warns while the daemon waits for the browser", async () => {
            const check = await daemonCheck(running({ state: "waiting", message: "Enable remote debugging." }));

            expect(check).toMatchObject({ level: "warn", detail: "waiting: Enable remote debugging." });
        });

        it("warns about a daemon that does not answer", async () => {
            const check = await daemonCheck({ kind: "unreachable", message: "timed out" });

            expect(check?.level).toBe("warn");
            expect(check?.fix?.[0]).toContain("daemon logs");
        });
    });
});

describe("formatChecks", () => {
    it("prints a line per check with the fix steps under it and a summary", () => {
        const text = formatChecks([
            { level: "ok", title: "Node.js", detail: "24.1.0" },
            { level: "fail", title: "Chrome", detail: "not found", fix: ["Install it.", "Retry."] },
            { level: "warn", title: "Daemon", detail: "waiting" },
        ]);

        expect(text).toBe(
            "[ok] Node.js: 24.1.0\n[fail] Chrome: not found\n       Install it.\n       Retry.\n[warn] Daemon: waiting\n1 problem found.\n",
        );
    });

    it("summarizes warnings and a clean run", () => {
        expect(formatChecks([{ level: "warn", title: "Daemon", detail: "x" }])).toContain(
            "No problems, but see the warnings above.",
        );
        expect(formatChecks([{ level: "ok", title: "Node.js", detail: "x" }])).toContain(
            "No problems found.",
        );
    });
});

describe("doctor optional programs", () => {
    const only = async (findProgram: DoctorDeps["findProgram"]) =>
        (await runDoctor(attach, deps({ findProgram }))).filter((check) =>
            ["ffmpeg", "lighthouse"].includes(check.title));

    it("shows where an installed program is", async () => {
        const checks = await only(async (name) => `/opt/bin/${name}`);

        expect(checks).toEqual([
            { level: "ok", title: "ffmpeg", detail: "/opt/bin/ffmpeg" },
            { level: "ok", title: "lighthouse", detail: "/opt/bin/lighthouse" },
        ]);
    });

    it("says what a missing program is for and how to install it, without raising a problem", async () => {
        const checks = await only(async () => undefined);

        expect(checks.map((check) => check.level)).toEqual(["info", "info"]);
        expect(checks[0]?.detail).toContain("screencast_stop");
        expect(checks[0]?.fix?.[0]).toContain("brew install ffmpeg");
        expect(checks[1]?.detail).toContain("lighthouse_audit");
        expect(checks[1]?.fix?.[0]).toContain("npm install -g lighthouse");

        const all = await runDoctor(attach, deps({ findProgram: async () => undefined }));

        expect(formatChecks(all)).toContain("No problems found.");
        expect(formatChecks(all)).toContain("[info] lighthouse:");
    });
});
