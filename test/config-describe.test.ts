import { describe, expect, it } from "vitest";
import { formatConfigReport } from "../src/cli-config.js";
import { ConfigError, describeConfig } from "../src/config/index.js";

function describeWith(
    file: string | undefined,
    env : NodeJS.ProcessEnv = {},
    argv: string[] = [],
) {
    return describeConfig({
        argv,
        env,
        platform: "linux",
        homedir : "/home/u",
        readFile: () => file,
    });
}

describe("describeConfig", () => {
    it("names the default as the source of every value when nothing is set", () => {
        const report = describeWith(undefined);

        expect(report.exists).toBe(false);
        expect(report.file).toBe("/home/u/.config/chromium-devtools-mcp/config.json");
        expect(new Set(Object.values(report.sources))).toEqual(new Set(["default"]));
        expect(report.config.mode).toBe("attach");
    });

    it("names the file, the environment and the flag as the source of what they set", () => {
        const report = describeWith(
            JSON.stringify({ mode: "managed", safety: { readOnly: true, deniedDomains: ["a.test"] } }),
            { CHROMIUM_DEVTOOLS_MCP_HEADLESS: "true", CHROMIUM_DEVTOOLS_MCP_ALLOWED_DOMAINS: "b.test" },
            ["--no-read-only", "--allow-focus"],
        );

        expect(report.exists).toBe(true);
        expect(report.sources).toMatchObject({
            mode                     : "file",
            headless                 : "env",
            allowFocus               : "flag",
            browser                  : "default",
            "safety.readOnly"        : "flag",
            "safety.deniedDomains"   : "file",
            "safety.allowedDomains"  : "env",
            "safety.confirmDangerous": "default",
        });
        expect(report.config.safety.readOnly).toBe(false);
    });

    it("lets a later source win and reports the one that won", () => {
        const report = describeWith(
            JSON.stringify({ isolated: true }),
            { CHROMIUM_DEVTOOLS_MCP_ISOLATED: "false" },
            ["--isolated"],
        );

        expect(report.config.isolated).toBe(true);
        expect(report.sources.isolated).toBe("flag");
    });

    it("refuses an invalid file with the field and the accepted forms", () => {
        expect(() => describeWith(JSON.stringify({ safety: { deniedDomains: ["https://x.test"] } })))
            .toThrow(ConfigError);
        expect(() => describeWith("{ not json")).toThrow(/invalid JSON/);
        expect(() => describeWith(JSON.stringify({ browsr: "chrome" }))).toThrow(ConfigError);
    });
});

describe("formatConfigReport", () => {
    it("lists every setting with its value and source and says the configuration is valid", () => {
        const text = formatConfigReport(
            describeWith(JSON.stringify({ safety: { allowedDomains: ["a.test", "b.test"] } }), {}, [
                "--mode=managed",
            ]),
        );

        expect(text).toContain("Config file: /home/u/.config/chromium-devtools-mcp/config.json (found)");
        expect(text).toMatch(/mode\s+managed\s+flag/);
        expect(text).toMatch(/safety\.allowedDomains\s+a\.test, b\.test\s+file/);
        expect(text).toMatch(/safety\.deniedDomains\s+\(empty\)\s+default/);
        expect(text).toMatch(/wsEndpoint\s+\(unset\)\s+default/);
        expect(text).toMatch(/safety\.allowPrivateNetworks\s+false\s+default/);
        expect(text).toContain("The configuration is valid.");
    });

    it("says when the file is missing", () => {
        expect(formatConfigReport(describeWith(undefined))).toContain("not found, the defaults apply");
    });
});
