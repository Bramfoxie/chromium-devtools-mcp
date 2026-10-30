import { describe, expect, it } from "vitest";
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
  homedir: "/home/u",
  env: { PATH: "/usr/local/bin:/usr/bin" },
};
const windows = {
  platform: "win32" as const,
  homedir: "C:\\Users\\u",
  env: {
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  },
};

describe("macOS", () => {
  it("finds Chrome in /Applications", () => {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    expect(findBrowserExecutable("chrome", { ...mac, exists: present(chrome) })).toBe(chrome);
  });

  it("finds Arc in the user Applications folder", () => {
    const arc = "/Users/u/Applications/Arc.app/Contents/MacOS/Arc";
    expect(findBrowserExecutable("arc", { ...mac, exists: present(arc) })).toBe(arc);
  });

  it("prefers the system-wide install over the user one", () => {
    const system = "/Applications/Arc.app/Contents/MacOS/Arc";
    const user = "/Users/u/Applications/Arc.app/Contents/MacOS/Arc";
    expect(findBrowserExecutable("arc", { ...mac, exists: present(user, system) })).toBe(system);
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

  it("reports Arc as unsupported", () => {
    expect(() => findBrowserExecutable("arc", { ...linux, exists: () => true })).toThrow(
      /not supported on linux/,
    );
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

  it("skips missing environment variables", () => {
    const candidates = browserCandidates("chrome", { ...windows, env: { PROGRAMFILES: "D:\\PF" } });
    expect(candidates).toEqual(["D:\\PF\\Google\\Chrome\\Application\\chrome.exe"]);
  });

  it("reports Arc as unsupported", () => {
    expect(() => findBrowserExecutable("arc", { ...windows, exists: () => true })).toThrow(
      BrowserNotFoundError,
    );
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
