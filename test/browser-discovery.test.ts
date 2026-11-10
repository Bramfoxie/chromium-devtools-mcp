import { describe, expect, it } from "vitest";
import { BROWSERS } from "../src/browser/browsers.js";
import { browsers } from "../src/config/index.js";
import {
    BrowserNotFoundError,
    browserCandidates,
    findBrowserExecutable,
    type DiscoveryOptions,
} from "../src/browser/index.js";

function present(...files: string[]): DiscoveryOptions["exists"] {
    const set = new Set(files);

    return (file) => set.has(file);
}

const mac = { platform: "darwin" as const, homedir: "/Users/u", env: {} };
const linux = {
    platform: "linux" as const,
    homedir : "/home/u",
    env     : { PATH: "/usr/local/bin:/usr/bin" },
};
const windows = {
    platform: "win32" as const,
    homedir : "C:\\Users\\u",
    env     : {
        LOCALAPPDATA       : "C:\\Users\\u\\AppData\\Local",
        PROGRAMFILES       : "C:\\Program Files",
        "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    },
};

describe("macOS", () => {
    it("finds Chrome in /Applications", () => {
        const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

        expect(findBrowserExecutable("chrome", { ...mac, exists: present(chrome) })).toBe(chrome);
    });

    it("finds Chrome in the user Applications folder", () => {
        const chrome = "/Users/u/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

        expect(findBrowserExecutable("chrome", { ...mac, exists: present(chrome) })).toBe(chrome);
    });

    it("prefers the system-wide install over the user one", () => {
        const system = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        const user = "/Users/u/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

        expect(findBrowserExecutable("chrome", { ...mac, exists: present(user, system) })).toBe(system);
    });
});

describe("Linux", () => {
    it("finds Chrome on PATH in PATH order", () => {
        const first = "/usr/local/bin/google-chrome";
        const second = "/usr/bin/google-chrome-stable";

        expect(findBrowserExecutable("chrome", { ...linux, exists: present(second, first) })).toBe(
            first,
        );
    });

    it("falls back to the fixed vendor location", () => {
        const fixed = "/opt/google/chrome/chrome";

        expect(findBrowserExecutable("chrome", { ...linux, exists: present(fixed) })).toBe(fixed);
    });

    it("works without PATH", () => {
        expect(browserCandidates("chrome", { ...linux, env: {} })).toEqual([
            "/opt/google/chrome/chrome",
        ]);
    });

    it("skips empty PATH segments", () => {
        const context = { ...linux, env: { PATH: "/a::/b" } };

        expect(browserCandidates("chrome", context).slice(0, 2)).toEqual([
            "/a/google-chrome-stable",
            "/a/google-chrome",
        ]);
    });
});

describe("Windows", () => {
    it("finds Chrome under Program Files", () => {
        const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

        expect(findBrowserExecutable("chrome", { ...windows, exists: present(chrome) })).toBe(chrome);
    });

    it("finds a per-user Chrome install", () => {
        const chrome = "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";

        expect(findBrowserExecutable("chrome", { ...windows, exists: present(chrome) })).toBe(chrome);
    });

    it("skips missing environment variables and prefers per-user paths", () => {
        const candidates = browserCandidates("chrome", { ...windows, env: { PROGRAMFILES: "D:\\PF" } });

        expect(candidates).toEqual([
            "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
            "D:\\PF\\Google\\Chrome\\Application\\chrome.exe",
        ]);
    });
});

describe("not found", () => {
    it("lists the searched locations and names the browser", () => {
        const failure = (() => {
            try {
                findBrowserExecutable("chrome", { ...mac, exists: () => false });
            } catch (error) {
                return error;
            }
        })();

        expect(failure).toBeInstanceOf(BrowserNotFoundError);
        expect((failure as Error).message).toContain("Could not find chrome on darwin");
        expect((failure as Error).message).toContain("/Applications/Google Chrome.app");
    });
});

describe("browser table", () => {
    it.each(browsers)("describes %s on every platform", (browser) => {
        for (const context of [mac, linux, windows]) {
            expect(BROWSERS[browser].label).not.toBe("");
            const noLinuxBuild = browser === "chrome-canary" && context === linux;

            expect(browserCandidates(browser, context).length > 0).toBe(!noLinuxBuild);
            expect(BROWSERS[browser].userDataDir(context)).not.toBe("");
        }

        expect(BROWSERS[browser].attachSteps(9222).join("\n")).toContain("9222");
    });
});
