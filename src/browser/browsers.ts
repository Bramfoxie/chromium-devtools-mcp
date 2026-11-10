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

interface BrowserLayout {
    label        : string;
    inspectScheme: "chrome" | "edge";
    macApp?      : string;
    windows?     : { dir: string[]; exe: string; machineWide: boolean };
    linuxNames   : string[];
    linuxFixed   : string[];
    macData      : string[];
    windowsData  : string[];
    linuxData    : string;
    steps?       : (debugPort: number) => string[];
}

const WINDOWS_CHROME = ["Google", "Chrome", "Application"];

const CHROME_STEPS = (debugPort: number): string[] => [
    'Option 1 (a recent Chrome): in the Chrome window you want to control, open chrome://inspect/#remote-debugging and turn on "Allow remote debugging for this browser instance". Chrome may ask you to approve a connection.',
    `Option 2: quit Chrome and start it with --remote-debugging-port=${debugPort} and --user-data-dir pointing to a non-default directory. Since Chrome 136 the port flag is ignored on the default profile, so the separate directory is required. This uses a separate profile, not your everyday one.`,
];

function genericSteps(layout: BrowserLayout, debugPort: number): string[] {
    const { label, inspectScheme } = layout;

    return [
        `Option 1: in the ${label} window you want to control, open ${inspectScheme}://inspect/#remote-debugging and turn on "Allow remote debugging for this browser instance" if your version offers it. ${label} may ask you to approve a connection.`,
        `Option 2: quit ${label} and start it with --remote-debugging-port=${debugPort} and --user-data-dir pointing to a non-default directory. Recent versions ignore the port flag on the default profile, so the separate directory is required. This uses a separate profile, not your everyday one.`,
    ];
}

function specFor(layout: BrowserLayout): BrowserSpec {
    return {
        label: layout.label,

        executables({ env, platform, homedir }) {
            const p = pathFor(platform);

            if (platform === "darwin") {
                if (layout.macApp === undefined) return [];

                const binary = `${layout.macApp}.app/Contents/MacOS/${layout.macApp}`;

                return [p.join("/Applications", binary), p.join(homedir, "Applications", binary)];
            }

            if (platform === "win32") {
                const { windows } = layout;

                if (windows === undefined) return [];

                const local = baseDir(env.LOCALAPPDATA, p.join(homedir, "AppData", "Local"), platform);
                const wide = windows.machineWide ? [env.PROGRAMFILES, env["PROGRAMFILES(X86)"]] : [];
                const roots = [local, ...wide].filter((root): root is string => Boolean(root));

                return roots.map((root) => p.join(root, ...windows.dir, windows.exe));
            }

            const dirs = (env.PATH ?? "").split(p.delimiter).filter((dir) => dir.length > 0);
            const onPath = dirs.flatMap(
                (dir) => layout.linuxNames.map((name) => p.join(dir, name)),
            );

            return [...onPath, ...layout.linuxFixed];
        },

        userDataDir({ env, platform, homedir }) {
            const p = pathFor(platform);

            if (platform === "darwin") {
                return p.join(homedir, "Library", "Application Support", ...layout.macData);
            }

            if (platform === "win32") {
                const base = baseDir(env.LOCALAPPDATA, p.join(homedir, "AppData", "Local"), platform);

                return p.join(base, ...layout.windowsData);
            }

            const base = baseDir(env.XDG_CONFIG_HOME, p.join(homedir, ".config"), platform);

            return p.join(base, layout.linuxData);
        },

        attachSteps: (debugPort) =>
            layout.steps === undefined ? genericSteps(layout, debugPort) : layout.steps(debugPort),
    };
}

const chrome = specFor({
    label        : "Chrome",
    inspectScheme: "chrome",
    macApp       : "Google Chrome",
    windows      : { dir: WINDOWS_CHROME, exe: "chrome.exe", machineWide: true },
    linuxNames   : ["google-chrome-stable", "google-chrome", "chrome"],
    linuxFixed   : ["/opt/google/chrome/chrome"],
    macData      : ["Google", "Chrome"],
    windowsData  : ["Google", "Chrome", "User Data"],
    linuxData    : "google-chrome",
    steps        : CHROME_STEPS,
});

const chromeBeta = specFor({
    label        : "Chrome Beta",
    inspectScheme: "chrome",
    macApp       : "Google Chrome Beta",
    windows      : {
        dir        : ["Google", "Chrome Beta", "Application"],
        exe        : "chrome.exe",
        machineWide: true,
    },
    linuxNames : ["google-chrome-beta"],
    linuxFixed : ["/opt/google/chrome-beta/chrome"],
    macData    : ["Google", "Chrome Beta"],
    windowsData: ["Google", "Chrome Beta", "User Data"],
    linuxData  : "google-chrome-beta",
});

const chromeDev = specFor({
    label        : "Chrome Dev",
    inspectScheme: "chrome",
    macApp       : "Google Chrome Dev",
    windows      : {
        dir        : ["Google", "Chrome Dev", "Application"],
        exe        : "chrome.exe",
        machineWide: true,
    },
    linuxNames : ["google-chrome-unstable"],
    linuxFixed : ["/opt/google/chrome-unstable/chrome"],
    macData    : ["Google", "Chrome Dev"],
    windowsData: ["Google", "Chrome Dev", "User Data"],
    linuxData  : "google-chrome-unstable",
});

const chromeCanary = specFor({
    label        : "Chrome Canary",
    inspectScheme: "chrome",
    macApp       : "Google Chrome Canary",
    windows      : {
        dir        : ["Google", "Chrome SxS", "Application"],
        exe        : "chrome.exe",
        machineWide: false,
    },
    linuxNames : [],
    linuxFixed : [],
    macData    : ["Google", "Chrome Canary"],
    windowsData: ["Google", "Chrome SxS", "User Data"],
    linuxData  : "google-chrome-canary",
});

const chromium = specFor({
    label        : "Chromium",
    inspectScheme: "chrome",
    macApp       : "Chromium",
    windows      : { dir: ["Chromium", "Application"], exe: "chrome.exe", machineWide: true },
    linuxNames   : ["chromium", "chromium-browser"],
    linuxFixed   : ["/snap/bin/chromium"],
    macData      : ["Chromium"],
    windowsData  : ["Chromium", "User Data"],
    linuxData    : "chromium",
});

const edge = specFor({
    label        : "Edge",
    inspectScheme: "edge",
    macApp       : "Microsoft Edge",
    windows      : {
        dir        : ["Microsoft", "Edge", "Application"],
        exe        : "msedge.exe",
        machineWide: true,
    },
    linuxNames : ["microsoft-edge-stable", "microsoft-edge"],
    linuxFixed : ["/opt/microsoft/msedge/msedge"],
    macData    : ["Microsoft Edge"],
    windowsData: ["Microsoft", "Edge", "User Data"],
    linuxData  : "microsoft-edge",
});

export const BROWSERS: Record<BrowserName, BrowserSpec> = {
    "chrome"       : chrome,
    "chrome-beta"  : chromeBeta,
    "chrome-dev"   : chromeDev,
    "chrome-canary": chromeCanary,
    chromium,
    edge,
};
