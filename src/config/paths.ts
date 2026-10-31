import path from "node:path";

export const APP_NAME = "chromium-devtools-mcp";

export interface PathContext {
    env     : NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    homedir : string;
}

export function pathFor(platform: NodeJS.Platform): typeof path.posix {
    return platform === "win32" ? path.win32 : path.posix;
}

// Empty and relative values are ignored.
export function baseDir(
    value: string | undefined,
    fallback: string,
    platform: NodeJS.Platform,
): string {
    return value && pathFor(platform).isAbsolute(value) ? value : fallback;
}

export function configFilePath({ env, platform, homedir }: PathContext): string {
    const p = pathFor(platform);
    const override = env.CHROMIUM_DEVTOOLS_MCP_CONFIG;

    if (override) return override;

    if (platform === "win32") {
        const base = baseDir(env.APPDATA, p.join(homedir, "AppData", "Roaming"), platform);

        return p.join(base, APP_NAME, "config.json");
    }

    const base = baseDir(env.XDG_CONFIG_HOME, p.join(homedir, ".config"), platform);

    return p.join(base, APP_NAME, "config.json");
}

export function defaultProfileDir({ env, platform, homedir }: PathContext): string {
    const p = pathFor(platform);

    if (platform === "win32") {
        const base = baseDir(env.LOCALAPPDATA, p.join(homedir, "AppData", "Local"), platform);

        return p.join(base, APP_NAME, "profile");
    }

    if (platform === "darwin") {
        return p.join(homedir, "Library", "Application Support", APP_NAME, "profile");
    }

    const base = baseDir(env.XDG_DATA_HOME, p.join(homedir, ".local", "share"), platform);

    return p.join(base, APP_NAME, "profile");
}
