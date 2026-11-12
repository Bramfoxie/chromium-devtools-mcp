import os from "node:os";
import { describe, expect, it } from "vitest";
import { ConfigError, configFilePath, defaultProfileDir, loadConfig } from "../src/config/index.js";

const base = { env: {}, platform: "linux" as const, homedir: "/home/u", argv: [] };

function withFile(content: string | undefined) {
    return { ...base, readFile: () => content };
}

describe("defaults", () => {
    it("returns the documented defaults", () => {
        expect(loadConfig(withFile(undefined))).toEqual({
            browser   : "chrome",
            mode      : "attach",
            headless  : false,
            profileDir: "/home/u/.local/share/chromium-devtools-mcp/profile",
            debugPort : 9222,
            allowFocus: false,
            isolated  : false,
            safety    : {
                readOnly            : false,
                allowedDomains      : [],
                deniedDomains       : [],
                allowPrivateNetworks: false,
                confirmDangerous    : false,
                uploadDirs          : [],
            },
        });
    });
});

describe("debugPort default", () => {
    it("is 0 in managed mode", () => {
        expect(loadConfig({ ...withFile(undefined), argv: ["--mode=managed"] }).debugPort).toBe(0);
    });

    it("keeps an explicit port in managed mode", () => {
        expect(
            loadConfig({ ...withFile(undefined), argv: ["--mode=managed", "--debug-port=9333"] }).debugPort,
        ).toBe(9333);
    });

    it("takes the mode from the file", () => {
        expect(loadConfig(withFile(JSON.stringify({ mode: "managed" }))).debugPort).toBe(0);
    });

    it("accepts 0 explicitly and rejects negatives", () => {
        expect(loadConfig({ ...withFile(undefined), argv: ["--debug-port=0"] }).debugPort).toBe(0);
        expect(() => loadConfig({ ...withFile(undefined), argv: ["--debug-port=-1"] })).toThrow(/debugPort/);
    });
});

describe("sources and precedence", () => {
    it("reads values from the config file", () => {
        const file = JSON.stringify({ headless: true, safety: { readOnly: true } });
        const config = loadConfig(withFile(file));

        expect(config.headless).toBe(true);
        expect(config.safety.readOnly).toBe(true);
        expect(config.safety.confirmDangerous).toBe(false);
    });

    it("lets env override the file", () => {
        const config = loadConfig({
            ...withFile(JSON.stringify({ mode: "attach", debugPort: 9000 })),
            env: { CHROMIUM_DEVTOOLS_MCP_MODE: "managed", CHROMIUM_DEVTOOLS_MCP_DEBUG_PORT: "9333" },
        });

        expect(config.mode).toBe("managed");
        expect(config.debugPort).toBe(9333);
    });

    it("lets argv override env", () => {
        const config = loadConfig({
            ...withFile(undefined),
            env : { CHROMIUM_DEVTOOLS_MCP_HEADLESS: "true" },
            argv: ["--no-headless", "--browser=chrome"],
        });

        expect(config.headless).toBe(false);
    });

    it("reads isolated from the file, env and argv in precedence order", () => {
        expect(loadConfig(withFile(JSON.stringify({ isolated: true }))).isolated).toBe(true);

        const fromEnv = loadConfig({
            ...withFile(JSON.stringify({ isolated: false })),
            env: { CHROMIUM_DEVTOOLS_MCP_ISOLATED: "true" },
        });

        expect(fromEnv.isolated).toBe(true);

        const fromArgv = loadConfig({
            ...withFile(undefined),
            env : { CHROMIUM_DEVTOOLS_MCP_ISOLATED: "false" },
            argv: ["--isolated"],
        });

        expect(fromArgv.isolated).toBe(true);
    });

    it("parses lists and booleans from env and argv", () => {
        const config = loadConfig({
            ...withFile(undefined),
            env: {
                CHROMIUM_DEVTOOLS_MCP_ALLOWED_DOMAINS       : "a.com, b.com",
                CHROMIUM_DEVTOOLS_MCP_READ_ONLY             : "1",
                CHROMIUM_DEVTOOLS_MCP_DENIED_DOMAINS        : "x.com, y.com",
                CHROMIUM_DEVTOOLS_MCP_ALLOW_PRIVATE_NETWORKS: "true",
            },
            argv: ["--confirm-dangerous", "--allowed-domains", "c.com"],
        });

        expect(config.safety).toEqual({
            readOnly            : true,
            allowedDomains      : ["c.com"],
            deniedDomains       : ["x.com", "y.com"],
            allowPrivateNetworks: true,
            confirmDangerous    : true,
            uploadDirs          : [],
        });
    });

    it("rejects an unknown flag instead of ignoring it", () => {
        expect(() => loadConfig({ ...withFile(undefined), argv: ["--readonly"] })).toThrow(
            new ConfigError("invalid command line: Unknown option '--readonly'"),
        );
        expect(() => loadConfig({ ...withFile(undefined), argv: ["--mod", "attach"] })).toThrow(
            /Unknown option '--mod'/,
        );
    });

    it("rejects positional arguments", () => {
        expect(() => loadConfig({ ...withFile(undefined), argv: ["install"] })).toThrow(ConfigError);
        expect(() => loadConfig({ ...withFile(undefined), argv: ["--headless", "extra"] })).toThrow(
            /invalid command line/,
        );
    });

    it("rejects a flag that lacks its value or gets one it does not take", () => {
        expect(() => loadConfig({ ...withFile(undefined), argv: ["--browser"] })).toThrow(
            /invalid command line: Option '--browser <value>' argument missing/,
        );
        expect(() => loadConfig({ ...withFile(undefined), argv: ["--headless=true"] })).toThrow(
            /invalid command line/,
        );
    });

    it("accepts every documented flag", () => {
        const config = loadConfig({
            ...withFile(undefined),
            argv: [
                "--browser=chrome",
                "--mode=managed",
                "--headless",
                "--profile-dir=/p",
                "--debug-port=9333",
                "--allow-focus",
                "--isolated",
                "--read-only",
                "--allowed-domains=a.com,b.com",
                "--denied-domains=x.com",
                "--allow-private-networks",
                "--confirm-dangerous",
            ],
        });

        expect(config).toEqual({
            browser   : "chrome",
            mode      : "managed",
            headless  : true,
            profileDir: "/p",
            debugPort : 9333,
            allowFocus: true,
            isolated  : true,
            safety    : {
                readOnly            : true,
                allowedDomains      : ["a.com", "b.com"],
                deniedDomains       : ["x.com"],
                allowPrivateNetworks: true,
                confirmDangerous    : true,
                uploadDirs          : [],
            },
        });
    });
});

describe("validation", () => {
    it("rejects a malformed deniedDomains entry with the accepted forms", () => {
        expect(() =>
            loadConfig({ ...withFile(undefined), argv: ["--denied-domains=http://x.com/path"] }),
        ).toThrow(/safety.deniedDomains.*accepted forms/);
    });

    it("lets a command line turn private networks off again", () => {
        const config = loadConfig({
            ...withFile(JSON.stringify({ safety: { allowPrivateNetworks: true } })),
            argv: ["--no-allow-private-networks"],
        });

        expect(config.safety.allowPrivateNetworks).toBe(false);
    });

    it("rejects an unknown browser with the field name", () => {
        expect(() => loadConfig({ ...withFile(undefined), argv: ["--browser=firefox"] })).toThrow(
            /browser/,
        );
    });

    it("rejects unknown keys in the file", () => {
        expect(() => loadConfig(withFile(JSON.stringify({ browsr: "chrome" })))).toThrow(ConfigError);
    });

    it("rejects an out of range port", () => {
        expect(() => loadConfig({ ...withFile(undefined), argv: ["--debug-port=70000"] })).toThrow(
            /debugPort/,
        );
    });

    it("rejects a non numeric port", () => {
        expect(() =>
            loadConfig({ ...withFile(undefined), env: { CHROMIUM_DEVTOOLS_MCP_DEBUG_PORT: "abc" } }),
        ).toThrow(/debugPort/);
    });

    it("rejects invalid JSON", () => {
        expect(() => loadConfig(withFile("{"))).toThrow(/invalid JSON/);
    });

    it("rejects a non object file", () => {
        expect(() => loadConfig(withFile("[]"))).toThrow(/JSON object/);
    });

    it("rejects a non object safety value", () => {
        expect(() => loadConfig(withFile(JSON.stringify({ safety: true })))).toThrow(/safety/);
    });

    it("rejects an invalid boolean in env", () => {
        expect(() =>
            loadConfig({ ...withFile(undefined), env: { CHROMIUM_DEVTOOLS_MCP_HEADLESS: "maybe" } }),
        ).toThrow(/headless/);
    });

    it("rejects unknown keys under safety", () => {
        expect(() =>
            loadConfig(withFile(JSON.stringify({ safety: { redOnly: true } }))),
        ).toThrow(ConfigError);
    });

    it.each([
        ['{"debugPort": "9333"}', "debugPort"],
        ['{"headless": 1}', "headless"],
        ['{"browser": null}', "browser"],
    ])("rejects a mistyped value %s", (content, field) => {
        expect(() => loadConfig(withFile(content))).toThrow(new RegExp(field));
    });

    it("rejects a fractional port", () => {
        expect(() => loadConfig({ ...withFile(undefined), argv: ["--debug-port=9222.5"] })).toThrow(
            /debugPort/,
        );
    });

    it("reports a read failure that is not a missing file", () => {
        expect(() =>
            loadConfig({
                argv    : [],
                env     : { CHROMIUM_DEVTOOLS_MCP_CONFIG: os.tmpdir() },
                platform: process.platform,
                homedir : os.homedir(),
            }),
        ).toThrow(/cannot read config file/);
    });

    it("fails when the overridden config file is missing but honors defaults otherwise", () => {
        expect(() =>
            loadConfig({
                ...base,
                env     : { CHROMIUM_DEVTOOLS_MCP_CONFIG: "/custom/config.json" },
                readFile: () => undefined,
            }),
        ).toThrow(/\/custom\/config.json does not exist/);
        expect(loadConfig(withFile(undefined)).browser).toBe("chrome");
    });

    it("accepts cased and padded booleans and rejects unknown words", () => {
        const config = loadConfig({
            ...withFile(undefined),
            env: { CHROMIUM_DEVTOOLS_MCP_HEADLESS: "  TRUE ", CHROMIUM_DEVTOOLS_MCP_READ_ONLY: " 1 " },
        });

        expect(config.headless).toBe(true);
        expect(config.safety.readOnly).toBe(true);

        for (const value of ["yes", "on"]) {
            expect(() =>
                loadConfig({
                    ...withFile(undefined),
                    env: { CHROMIUM_DEVTOOLS_MCP_HEADLESS: value },
                }),
            ).toThrow(/headless/);
        }
    });

    it("treats empty env values as unset and trims domain lists", () => {
        const config = loadConfig({
            ...withFile(JSON.stringify({ safety: { allowedDomains: ["file.com"] } })),
            env: {
                CHROMIUM_DEVTOOLS_MCP_BROWSER        : "",
                CHROMIUM_DEVTOOLS_MCP_ALLOWED_DOMAINS: "   ",
                CHROMIUM_DEVTOOLS_MCP_HEADLESS       : " \t ",
            },
        });

        expect(config.browser).toBe("chrome");
        expect(config.headless).toBe(false);
        expect(config.safety.allowedDomains).toEqual(["file.com"]);

        const listed = loadConfig({
            ...withFile(undefined),
            env: { CHROMIUM_DEVTOOLS_MCP_ALLOWED_DOMAINS: "a.com,, b.com" },
        });

        expect(listed.safety.allowedDomains).toEqual(["a.com", "b.com"]);
    });

    it("accepts every negative boolean flag", () => {
        const config = loadConfig({
            ...withFile(undefined),
            env: {
                CHROMIUM_DEVTOOLS_MCP_ALLOW_FOCUS      : "true",
                CHROMIUM_DEVTOOLS_MCP_ISOLATED         : "true",
                CHROMIUM_DEVTOOLS_MCP_READ_ONLY        : "true",
                CHROMIUM_DEVTOOLS_MCP_CONFIRM_DANGEROUS: "true",
            },
            argv: ["--no-allow-focus", "--no-isolated", "--no-read-only", "--no-confirm-dangerous"],
        });

        expect(config.allowFocus).toBe(false);
        expect(config.isolated).toBe(false);
        expect(config.safety.readOnly).toBe(false);
        expect(config.safety.confirmDangerous).toBe(false);
    });

    it("falls back to XDG paths on unknown platforms", () => {
        const config = loadConfig({
            ...withFile(undefined),
            platform: "freebsd" as never,
            argv    : [],
        });

        expect(config.profileDir).toBe("/home/u/.local/share/chromium-devtools-mcp/profile");
        expect(
            configFilePath({ env: {}, platform: "freebsd", homedir: "/home/u" }),
        ).toBe("/home/u/.config/chromium-devtools-mcp/config.json");
    });
});

describe("wsEndpoint", () => {
    const given = "ws://127.0.0.1:9444/devtools/browser/abc";

    it("is unset by default", () => {
        expect(loadConfig(withFile(undefined)).wsEndpoint).toBeUndefined();
    });

    it("is read from the file, env and flag in precedence order", () => {
        const file = JSON.stringify({ wsEndpoint: "ws://127.0.0.1:1/devtools/browser/file" });
        const env = { CHROMIUM_DEVTOOLS_MCP_WS_ENDPOINT: "ws://127.0.0.1:2/devtools/browser/env" };

        expect(loadConfig(withFile(file)).wsEndpoint).toBe("ws://127.0.0.1:1/devtools/browser/file");
        expect(loadConfig({ ...withFile(file), env }).wsEndpoint).toBe(
            "ws://127.0.0.1:2/devtools/browser/env",
        );
        expect(
            loadConfig({ ...withFile(file), env, argv: [`--ws-endpoint=${given}`] }).wsEndpoint,
        ).toBe(given);
    });

    it.each([
        "ws://localhost:9222/devtools/browser/abc",
        "ws://[::1]:9222/devtools/browser/abc",
    ])("accepts the loopback endpoint %s", (value) => {
        expect(loadConfig({ ...withFile(undefined), argv: [`--ws-endpoint=${value}`] }).wsEndpoint).toBe(
            value,
        );
    });

    it.each([
        "garbage",
        "http://127.0.0.1:9222/devtools/browser/abc",
        "wss://127.0.0.1:9222/devtools/browser/abc",
        "ws://example.com:9222/devtools/browser/abc",
        "ws://192.168.1.5:9222/devtools/browser/abc",
        "ws://127.0.0.1/devtools/browser/abc",
        "ws://127.0.0.1:9222/json/version",
        "ws://127.0.0.1:9222/devtools/browser/",
        "ws://user:pass@127.0.0.1:9222/devtools/browser/abc",
        "ws://127.0.0.1:9222/devtools/browser/abc?x=1",
        "ws://127.0.0.1:9222/devtools/browser/abc#x",
    ])("rejects the endpoint %s", (value) => {
        expect(() =>
            loadConfig({ ...withFile(undefined), argv: [`--ws-endpoint=${value}`] }),
        ).toThrow(/wsEndpoint: invalid endpoint/);
    });

    it("is refused in managed mode", () => {
        expect(() =>
            loadConfig({ ...withFile(undefined), argv: ["--mode=managed", `--ws-endpoint=${given}`] }),
        ).toThrow(/wsEndpoint: is used only in attach mode/);
    });
});

describe("paths", () => {
    it("resolves the config file on macOS and Linux", () => {
        expect(configFilePath({ env: {}, platform: "darwin", homedir: "/Users/u" })).toBe(
            "/Users/u/.config/chromium-devtools-mcp/config.json",
        );
        expect(
            configFilePath({ env: { XDG_CONFIG_HOME: "/x" }, platform: "linux", homedir: "/home/u" }),
        ).toBe("/x/chromium-devtools-mcp/config.json");
    });

    it("resolves the config file on Windows", () => {
        expect(configFilePath({ env: {}, platform: "win32", homedir: "C:\\Users\\u" })).toBe(
            "C:\\Users\\u\\AppData\\Roaming\\chromium-devtools-mcp\\config.json",
        );
        expect(
            configFilePath({ env: { APPDATA: "D:\\Data" }, platform: "win32", homedir: "C:\\Users\\u" }),
        ).toBe("D:\\Data\\chromium-devtools-mcp\\config.json");
    });

    it.each(["", "relative/dir"])("ignores a base directory variable set to %j", (value) => {
        const env = {
            XDG_CONFIG_HOME: value,
            XDG_DATA_HOME  : value,
            APPDATA        : value,
            LOCALAPPDATA   : value,
        };

        expect(configFilePath({ env, platform: "linux", homedir: "/home/u" })).toBe(
            "/home/u/.config/chromium-devtools-mcp/config.json",
        );
        expect(defaultProfileDir({ env, platform: "linux", homedir: "/home/u" })).toBe(
            "/home/u/.local/share/chromium-devtools-mcp/profile",
        );
        expect(configFilePath({ env, platform: "win32", homedir: "C:\\Users\\u" })).toBe(
            "C:\\Users\\u\\AppData\\Roaming\\chromium-devtools-mcp\\config.json",
        );
        expect(defaultProfileDir({ env, platform: "win32", homedir: "C:\\Users\\u" })).toBe(
            "C:\\Users\\u\\AppData\\Local\\chromium-devtools-mcp\\profile",
        );
    });

    it("honors the config path override", () => {
        const env = { CHROMIUM_DEVTOOLS_MCP_CONFIG: "/custom/config.json" };

        expect(configFilePath({ env, platform: "linux", homedir: "/home/u" })).toBe(
            "/custom/config.json",
        );
    });

    it("resolves the default profile directory per platform", () => {
        expect(defaultProfileDir({ env: {}, platform: "darwin", homedir: "/Users/u" })).toBe(
            "/Users/u/Library/Application Support/chromium-devtools-mcp/profile",
        );
        expect(defaultProfileDir({ env: {}, platform: "win32", homedir: "C:\\Users\\u" })).toBe(
            "C:\\Users\\u\\AppData\\Local\\chromium-devtools-mcp\\profile",
        );
        expect(defaultProfileDir({ env: {}, platform: "linux", homedir: "/home/u" })).toBe(
            "/home/u/.local/share/chromium-devtools-mcp/profile",
        );
    });

    it("resolves the default profile directory with platform overrides", () => {
        expect(
            defaultProfileDir({ env: { XDG_DATA_HOME: "/x" }, platform: "linux", homedir: "/home/u" }),
        ).toBe("/x/chromium-devtools-mcp/profile");
        expect(
            defaultProfileDir({
                env     : { LOCALAPPDATA: "D:\\Data" },
                platform: "win32",
                homedir : "C:\\Users\\u",
            }),
        ).toBe("D:\\Data\\chromium-devtools-mcp\\profile");
        expect(
            defaultProfileDir({
                env     : { XDG_DATA_HOME: "/x" },
                platform: "darwin",
                homedir : "/Users/u",
            }),
        ).toBe("/Users/u/Library/Application Support/chromium-devtools-mcp/profile");
    });

    it("reads the file at the platform config path", () => {
        const cases = [
            {
                context : { env: {}, platform: "linux" as const, homedir: "/home/u" },
                expected: "/home/u/.config/chromium-devtools-mcp/config.json",
            },
            {
                context : { env: {}, platform: "darwin" as const, homedir: "/Users/u" },
                expected: "/Users/u/.config/chromium-devtools-mcp/config.json",
            },
            {
                context : { env: {}, platform: "win32" as const, homedir: "C:\\Users\\u" },
                expected: "C:\\Users\\u\\AppData\\Roaming\\chromium-devtools-mcp\\config.json",
            },
        ];

        for (const { context, expected } of cases) {
            let seen: string | undefined;

            loadConfig({
                ...context,
                argv    : [],
                readFile: (file) => {
                    seen = file;

                    return undefined;
                },
            });
            expect(seen).toBe(expected);
        }
    });
});

describe("profileDir", () => {
    it.each(["./p", "rel/dir", "~/profile", "profile"])("rejects the relative path %s", (value) => {
        expect(() => loadConfig({ ...withFile(undefined), argv: [`--profile-dir=${value}`] })).toThrow(
            /profileDir: must be an absolute path/,
        );
    });

    it("rejects a relative path from the file and from the environment", () => {
        expect(() => loadConfig(withFile(JSON.stringify({ profileDir: "p" })))).toThrow(/profileDir/);
        expect(() =>
            loadConfig({ ...withFile(undefined), env: { CHROMIUM_DEVTOOLS_MCP_PROFILE_DIR: "~/p" } }),
        ).toThrow(/profileDir/);
    });

    it("accepts absolute paths of the platform", () => {
        const posix = loadConfig({ ...withFile(undefined), argv: ["--profile-dir=/data/p"] });
        const win = loadConfig({
            ...withFile(undefined),
            platform: "win32",
            argv    : ["--profile-dir=C:\\data\\p"],
        });

        expect(posix.profileDir).toBe("/data/p");
        expect(win.profileDir).toBe("C:\\data\\p");
    });
});

describe("allowedDomains validation", () => {
    const bad = ["https://example.com", "example.com/path", "*", "   ", "a b.com", ""];

    it.each(bad)("rejects the file entry %j and names it with the accepted forms", (entry) => {
        const file = JSON.stringify({ safety: { allowedDomains: [entry] } });

        expect(() => loadConfig(withFile(file))).toThrow(ConfigError);
        expect(() => loadConfig(withFile(file))).toThrow(/safety\.allowedDomains\.0: invalid entry/);
        expect(() => loadConfig(withFile(file))).toThrow(/\*\.example\.com.*localhost:3000.*\[::1\]:3000/);
    });

    it("rejects a bad entry from the environment and the flag", () => {
        const env = { CHROMIUM_DEVTOOLS_MCP_ALLOWED_DOMAINS: "a.com,https://b.com" };

        expect(() => loadConfig({ ...withFile(undefined), env })).toThrow(/"https:\/\/b\.com"/);
        expect(() =>
            loadConfig({ ...withFile(undefined), argv: ["--allowed-domains=a.com,example.com/x"] }),
        ).toThrow(/"example\.com\/x"/);
    });

    it("accepts the documented forms", () => {
        const domains = ["example.com", "*.example.com", "localhost:3000", "[::1]:3000"];
        const file = JSON.stringify({ safety: { allowedDomains: domains } });
        const config = loadConfig(withFile(file));

        expect(config.safety.allowedDomains).toEqual(domains);
    });
});

describe("safety.uploadDirs", () => {
    it("is empty by default and read from the file, the environment and the command line", () => {
        expect(loadConfig(withFile(undefined)).safety.uploadDirs).toEqual([]);
        expect(
            loadConfig(withFile(JSON.stringify({ safety: { uploadDirs: ["/srv/a"] } }))).safety.uploadDirs,
        ).toEqual(["/srv/a"]);
        expect(
            loadConfig({
                ...withFile(JSON.stringify({ safety: { uploadDirs: ["/srv/a"] } })),
                env: { CHROMIUM_DEVTOOLS_MCP_UPLOAD_DIRS: "/srv/b, /srv/c" },
            }).safety.uploadDirs,
        ).toEqual(["/srv/b", "/srv/c"]);
        expect(
            loadConfig({
                ...withFile(undefined),
                env : { CHROMIUM_DEVTOOLS_MCP_UPLOAD_DIRS: "/srv/b" },
                argv: ["--upload-dirs=/srv/d"],
            }).safety.uploadDirs,
        ).toEqual(["/srv/d"]);
    });

    it("accepts absolute directories of either platform and rejects relative ones", () => {
        expect(
            loadConfig({ ...withFile(undefined), argv: ["--upload-dirs=C:\\Users\\u\\up,/srv/x"] })
                .safety.uploadDirs,
        ).toEqual(["C:\\Users\\u\\up", "/srv/x"]);
        expect(() => loadConfig({ ...withFile(undefined), argv: ["--upload-dirs=relative/dir"] }))
            .toThrow(/safety.uploadDirs.*absolute/);
    });
});
