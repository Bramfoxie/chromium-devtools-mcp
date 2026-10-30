import { existsSync } from "node:fs";
import os from "node:os";
import type { Config } from "../config/index.js";
import { pathFor } from "./platform-path.js";

export type BrowserName = Config["browser"];

export interface DiscoveryContext {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
}

export interface DiscoveryOptions extends Partial<DiscoveryContext> {
  exists?: (file: string) => boolean;
}

export class BrowserNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserNotFoundError";
  }
}

const MAC_EXECUTABLES: Record<BrowserName, string> = {
  chrome: "Google Chrome.app/Contents/MacOS/Google Chrome",
  arc: "Arc.app/Contents/MacOS/Arc",
};

const LINUX_CHROME_NAMES = ["google-chrome-stable", "google-chrome", "chrome"];
const LINUX_CHROME_FIXED = ["/opt/google/chrome/chrome"];
const WINDOWS_CHROME_RELATIVE = ["Google", "Chrome", "Application", "chrome.exe"];
const WINDOWS_ROOT_VARIABLES = ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"];

export function browserCandidates(
  browser: BrowserName,
  { env, platform, homedir }: DiscoveryContext,
): string[] {
  const p = pathFor(platform);
  if (platform === "darwin") {
    const relative = MAC_EXECUTABLES[browser];
    return [p.join("/Applications", relative), p.join(homedir, "Applications", relative)];
  }
  if (browser !== "chrome") return [];
  if (platform === "win32") {
    return WINDOWS_ROOT_VARIABLES.flatMap((name) => {
      const root = env[name];
      return root ? [p.join(root, ...WINDOWS_CHROME_RELATIVE)] : [];
    });
  }
  const dirs = (env.PATH ?? "").split(p.delimiter).filter((dir) => dir.length > 0);
  const onPath = dirs.flatMap((dir) => LINUX_CHROME_NAMES.map((name) => p.join(dir, name)));
  return [...onPath, ...LINUX_CHROME_FIXED];
}

export function findBrowserExecutable(
  browser: BrowserName,
  options: DiscoveryOptions = {},
): string {
  const context: DiscoveryContext = {
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    homedir: options.homedir ?? os.homedir(),
  };
  const exists = options.exists ?? existsSync;
  const candidates = browserCandidates(browser, context);
  if (candidates.length === 0) {
    throw new BrowserNotFoundError(
      `Browser ${browser} is not supported on ${context.platform}. Set browser to chrome in the config.`,
    );
  }
  const found = candidates.find((candidate) => exists(candidate));
  if (found) return found;
  throw new BrowserNotFoundError(
    `Could not find ${browser} on ${context.platform}. Install it or check these locations: ${candidates.join(", ")}.`,
  );
}
