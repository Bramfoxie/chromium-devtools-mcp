import { baseDir, pathFor, type Config } from "../config/index.js";

export type BrowserName = Config["browser"];

export interface DiscoveryContext {
  env     : NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir : string;
}

export interface BrowserSpec {
  label      : string;
  executables: (context: DiscoveryContext) => string[];
  userDataDir: (context: DiscoveryContext) => string;
  attachSteps: (debugPort: number) => string[];
}

const MAC_CHROME = "Google Chrome.app/Contents/MacOS/Google Chrome";
const LINUX_CHROME_NAMES = ["google-chrome-stable", "google-chrome", "chrome"];
const LINUX_CHROME_FIXED = ["/opt/google/chrome/chrome"];
const WINDOWS_CHROME = ["Google", "Chrome", "Application", "chrome.exe"];

const chrome: BrowserSpec = {
  label: "Chrome",

  executables({ env, platform, homedir }) {
    const p = pathFor(platform);

    if (platform === "darwin") {
      return [p.join("/Applications", MAC_CHROME), p.join(homedir, "Applications", MAC_CHROME)];
    }

    if (platform === "win32") {
      const local = baseDir(env.LOCALAPPDATA, p.join(homedir, "AppData", "Local"), platform);
      const roots = [local, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter(
        (root): root is string => Boolean(root),
      );

      return roots.map((root) => p.join(root, ...WINDOWS_CHROME));
    }

    const dirs = (env.PATH ?? "").split(p.delimiter).filter((dir) => dir.length > 0);
    const onPath = dirs.flatMap((dir) => LINUX_CHROME_NAMES.map((name) => p.join(dir, name)));

    return [...onPath, ...LINUX_CHROME_FIXED];
  },

  userDataDir({ env, platform, homedir }) {
    const p = pathFor(platform);

    if (platform === "darwin") {
      return p.join(homedir, "Library", "Application Support", "Google", "Chrome");
    }

    if (platform === "win32") {
      const base = baseDir(env.LOCALAPPDATA, p.join(homedir, "AppData", "Local"), platform);

      return p.join(base, "Google", "Chrome", "User Data");
    }

    const base = baseDir(env.XDG_CONFIG_HOME, p.join(homedir, ".config"), platform);

    return p.join(base, "google-chrome");
  },

  attachSteps: (debugPort) => [
    'Option 1 (a recent Chrome): in the Chrome window you want to control, open chrome://inspect/#remote-debugging and turn on "Allow remote debugging for this browser instance". Chrome may ask you to approve a connection.',
    `Option 2: quit Chrome and start it with --remote-debugging-port=${debugPort} and --user-data-dir pointing to a non-default directory. Since Chrome 136 the port flag is ignored on the default profile, so the separate directory is required. This uses a separate profile, not your everyday one.`,
  ],
};

export const BROWSERS: Record<BrowserName, BrowserSpec> = { chrome };
