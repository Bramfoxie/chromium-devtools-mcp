import { describe, expect, it } from "vitest";
import {
    currentPathContext,
    currentUsername,
    type DaemonPathContext,
    maxSocketPathBytes,
    runtimeDir,
    socketPath,
    tokenPath,
} from "../src/daemon/index.js";

const token = "a".repeat(64);
const linux: DaemonPathContext = {
    env     : {},
    platform: "linux",
    homedir : "/home/u",
    uid     : 1000,
    username: "u",
};
const mac: DaemonPathContext = {
    env     : {},
    platform: "darwin",
    homedir : "/Users/u",
    uid     : 501,
    username: "u",
};
const windows: DaemonPathContext = {
    env     : { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
    platform: "win32",
    homedir : "C:\\Users\\u",
    uid     : undefined,
    username: "u",
};

describe("socketPath and runtimeDir", () => {
    it("uses a per-user directory under /tmp on macOS and Linux", () => {
        expect(runtimeDir(linux)).toBe("/tmp/chromium-devtools-mcp-1000");
        expect(socketPath(linux, token)).toMatch(
            /^\/tmp\/chromium-devtools-mcp-1000\/daemon-[0-9a-f]{8}\.sock$/,
        );
        expect(socketPath(mac, token)).toMatch(
            /^\/tmp\/chromium-devtools-mcp-501\/daemon-[0-9a-f]{8}\.sock$/,
        );
    });

    it("keeps clients with different data directories apart", () => {
        const other = { ...linux, env: { XDG_DATA_HOME: "/data/other" } };

        expect(socketPath(other, token)).not.toBe(socketPath(linux, token));
        const same = { ...linux, env: { ...other.env } };

        expect(socketPath(same, token)).toBe(socketPath(other, token));
    });

    it("does not depend on TMPDIR or XDG_RUNTIME_DIR", () => {
        const env = { TMPDIR: "/somewhere/else", XDG_RUNTIME_DIR: "/run/user/1000" };

        expect(socketPath({ ...linux, env }, token)).toBe(socketPath(linux, token));
        expect(socketPath({ ...mac, env }, token)).toBe(socketPath(mac, token));
    });

    it("falls back to the user name when the uid is unknown", () => {
        expect(socketPath({ ...linux, uid: undefined }, token)).toMatch(
            /^\/tmp\/chromium-devtools-mcp-u\/daemon-[0-9a-f]{8}\.sock$/,
        );
    });

    it("uses a named pipe without a runtime directory on Windows", () => {
        expect(runtimeDir(windows)).toBeUndefined();
        expect(socketPath(windows, token)).toMatch(
            /^\\\\\.\\pipe\\chromium-devtools-mcp-u-[0-9a-f]{16}$/,
        );
    });

    it("derives an unpredictable pipe name from the token", () => {
        const other = "b".repeat(64);

        expect(socketPath(windows, token)).toBe(socketPath(windows, token));
        expect(socketPath(windows, token)).not.toBe(socketPath(windows, other));
        expect(socketPath(windows, token)).not.toContain(token);
    });

    it("removes path separators from the Windows user name", () => {
        expect(socketPath({ ...windows, username: "DOMAIN\\user/x" }, token)).toContain(
            "chromium-devtools-mcp-DOMAIN_user_x-",
        );
    });
});

describe("tokenPath", () => {
    it("lives next to the managed profile in the user data directory", () => {
        expect(tokenPath(mac)).toBe(
            "/Users/u/Library/Application Support/chromium-devtools-mcp/daemon.token",
        );
        expect(tokenPath(linux)).toBe("/home/u/.local/share/chromium-devtools-mcp/daemon.token");
        expect(tokenPath({ ...linux, env: { XDG_DATA_HOME: "/data" } })).toBe(
            "/data/chromium-devtools-mcp/daemon.token",
        );
        expect(tokenPath(windows)).toBe(
            "C:\\Users\\u\\AppData\\Local\\chromium-devtools-mcp\\daemon.token",
        );
    });
});

describe("maxSocketPathBytes", () => {
    it("reflects the platform limits", () => {
        expect(maxSocketPathBytes("darwin")).toBe(103);
        expect(maxSocketPathBytes("linux")).toBe(107);
        expect(maxSocketPathBytes("win32")).toBe(Number.POSITIVE_INFINITY);
    });
});

describe("currentUsername", () => {
    it("returns the account name when the lookup works", () => {
        expect(currentUsername({}, () => ({ username: "milana" }))).toBe("milana");
    });

    it("falls back to the environment when the account has no passwd entry", () => {
        const failing = () => {
            throw new Error("ENOENT");
        };

        expect(currentUsername({ USER: "ci" }, failing)).toBe("ci");
        expect(currentUsername({ USERNAME: "winci" }, failing)).toBe("winci");
        expect(currentUsername({}, failing)).toBe("user");
    });

    it("builds a context for the running process", () => {
        const context = currentPathContext();

        expect(context.platform).toBe(process.platform);
        expect(context.username.length).toBeGreaterThan(0);
    });
});
