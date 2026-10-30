import { describe, expect, it } from "vitest";
import { ConfigError, configFilePath, defaultProfileDir, loadConfig } from "../src/config/index.js";

const base = { env: {}, platform: "linux" as const, homedir: "/home/u", argv: [] };

function withFile(content: string | undefined) {
  return { ...base, readFile: () => content };
}

describe("defaults", () => {
  it("returns the documented defaults", () => {
    expect(loadConfig(withFile(undefined))).toEqual({
      browser: "chrome",
      mode: "attach",
      headless: false,
      profileDir: "/home/u/.local/share/chromium-devtools-mcp/profile",
      debugPort: 9222,
      allowFocus: false,
      safety: { readOnly: false, allowedDomains: [], confirmDangerous: false },
    });
  });
});

describe("sources and precedence", () => {
  it("reads values from the config file", () => {
    const file = JSON.stringify({ browser: "arc", safety: { readOnly: true } });
    const config = loadConfig(withFile(file));
    expect(config.browser).toBe("arc");
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
      env: { CHROMIUM_DEVTOOLS_MCP_HEADLESS: "true" },
      argv: ["--no-headless", "--browser=arc"],
    });
    expect(config.headless).toBe(false);
    expect(config.browser).toBe("arc");
  });

  it("parses lists and booleans from env and argv", () => {
    const config = loadConfig({
      ...withFile(undefined),
      env: {
        CHROMIUM_DEVTOOLS_MCP_ALLOWED_DOMAINS: "a.com, b.com",
        CHROMIUM_DEVTOOLS_MCP_READ_ONLY: "1",
      },
      argv: ["--confirm-dangerous", "--allowed-domains", "c.com"],
    });
    expect(config.safety).toEqual({
      readOnly: true,
      allowedDomains: ["c.com"],
      confirmDangerous: true,
    });
  });

  it("ignores unrelated argv entries", () => {
    const config = loadConfig({ ...withFile(undefined), argv: ["install", "--client", "cursor"] });
    expect(config.mode).toBe("attach");
  });
});

describe("validation", () => {
  it("rejects an unknown browser with the field name", () => {
    expect(() => loadConfig({ ...withFile(undefined), argv: ["--browser=firefox"] })).toThrow(
      /browser/,
    );
  });

  it("rejects unknown keys in the file", () => {
    expect(() => loadConfig(withFile(JSON.stringify({ browsr: "arc" })))).toThrow(ConfigError);
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
  });
});
