import { describe, expect, it } from "vitest";
import { BROWSERS } from "../src/browser/browsers.js";
import { browserUserDataDir } from "../src/browser/attach.js";
import { browserCandidates, BrowserNotFoundError, findBrowserExecutable } from "../src/browser/index.js";
import { browsers, loadConfig } from "../src/config/index.js";

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

describe("the supported browsers", () => {
    it("lists Chrome, its channels, Chromium and Edge", () => {
        expect([...browsers]).toEqual([
            "chrome",
            "chrome-beta",
            "chrome-dev",
            "chrome-canary",
            "chromium",
            "edge",
        ]);
        expect(Object.keys(BROWSERS)).toEqual([...browsers]);
    });

    it("accepts each of them as the browser setting", () => {
        for (const browser of browsers) {
            const config = loadConfig({
                argv    : ["--browser", browser],
                env     : {},
                platform: "linux",
                homedir : "/home/u",
                readFile: () => undefined,
            });

            expect(config.browser).toBe(browser);
        }
    });
});

describe("macOS locations", () => {
    it.each([
        ["chrome-beta", "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta", "Google/Chrome Beta"],
        ["chrome-dev", "Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev", "Google/Chrome Dev"],
        ["chrome-canary", "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary", "Google/Chrome Canary"],
        ["chromium", "Chromium.app/Contents/MacOS/Chromium", "Chromium"],
        ["edge", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "Microsoft Edge"],
    ] as const)("%s", (browser, binary, data) => {
        expect(browserCandidates(browser, mac)).toEqual([
            `/Applications/${binary}`,
            `/Users/u/Applications/${binary}`,
        ]);
        expect(browserUserDataDir(browser, mac)).toBe(`/Users/u/Library/Application Support/${data}`);
    });
});

describe("Linux locations", () => {
    it.each([
        ["chrome-beta", "google-chrome-beta", "/opt/google/chrome-beta/chrome", "google-chrome-beta"],
        ["chrome-dev", "google-chrome-unstable", "/opt/google/chrome-unstable/chrome", "google-chrome-unstable"],
        ["edge", "microsoft-edge-stable", "/opt/microsoft/msedge/msedge", "microsoft-edge"],
    ] as const)("%s", (browser, name, fixed, data) => {
        const candidates = browserCandidates(browser, linux);

        expect(candidates).toContain(`/usr/bin/${name}`);
        expect(candidates).toContain(fixed);
        expect(browserUserDataDir(browser, linux)).toBe(`/home/u/.config/${data}`);
    });

    it("finds Chromium under its two common names and the snap path", () => {
        const candidates = browserCandidates("chromium", linux);

        expect(candidates).toEqual(expect.arrayContaining([
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
        ]));
        expect(browserUserDataDir("chromium", linux)).toBe("/home/u/.config/chromium");
    });

    it("has no Canary build and says so", () => {
        expect(browserCandidates("chrome-canary", linux)).toEqual([]);
        expect(() => findBrowserExecutable("chrome-canary", { ...linux, exists: () => false }))
            .toThrow(/no chrome-canary build for linux/i);
        expect(() => findBrowserExecutable("chrome-canary", { ...linux, exists: () => false }))
            .toThrow(BrowserNotFoundError);
    });
});

describe("Windows locations", () => {
    const local = "C:\\Users\\u\\AppData\\Local";

    it.each([
        ["chrome-beta", ["Google", "Chrome Beta", "Application", "chrome.exe"], "Google\\Chrome Beta\\User Data"],
        ["chrome-dev", ["Google", "Chrome Dev", "Application", "chrome.exe"], "Google\\Chrome Dev\\User Data"],
        ["chrome-canary", ["Google", "Chrome SxS", "Application", "chrome.exe"], "Google\\Chrome SxS\\User Data"],
        ["chromium", ["Chromium", "Application", "chrome.exe"], "Chromium\\User Data"],
        ["edge", ["Microsoft", "Edge", "Application", "msedge.exe"], "Microsoft\\Edge\\User Data"],
    ] as const)("%s", (browser, parts, data) => {
        const candidates = browserCandidates(browser, windows);

        expect(candidates).toContain(`${local}\\${parts.join("\\")}`);
        expect(candidates.includes(`C:\\Program Files\\${parts.join("\\")}`)).toBe(
            browser !== "chrome-canary",
        );
        expect(browserUserDataDir(browser, windows)).toBe(`${local}\\${data}`);
    });
});

describe("attach steps", () => {
    it("name the inspect page of the browser", () => {
        expect(BROWSERS.edge.attachSteps(9222).join(" ")).toContain("edge://inspect");
        expect(BROWSERS["chrome-beta"].attachSteps(9222).join(" ")).toContain("chrome://inspect");
        expect(BROWSERS.chromium.attachSteps(9222).join(" ")).toContain("--remote-debugging-port=9222");
    });
});
