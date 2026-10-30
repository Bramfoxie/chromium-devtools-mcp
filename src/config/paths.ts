import path from "node:path";

const APP_NAME = "chromium-devtools-mcp";

export interface PathContext {
  env     : NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir : string;
}

function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

export function configFilePath({ env, platform, homedir }: PathContext): string {
  const p = pathFor(platform);
  const override = env.CHROMIUM_DEVTOOLS_MCP_CONFIG;

  if (override) return override;

  if (platform === "win32") {
    const base = env.APPDATA ?? p.join(homedir, "AppData", "Roaming");

    return p.join(base, APP_NAME, "config.json");
  }

  const base = env.XDG_CONFIG_HOME ?? p.join(homedir, ".config");

  return p.join(base, APP_NAME, "config.json");
}

export function defaultProfileDir({ env, platform, homedir }: PathContext): string {
  const p = pathFor(platform);

  if (platform === "win32") {
    const base = env.LOCALAPPDATA ?? p.join(homedir, "AppData", "Local");

    return p.join(base, APP_NAME, "profile");
  }

  if (platform === "darwin") {
    return p.join(homedir, "Library", "Application Support", APP_NAME, "profile");
  }

  const base = env.XDG_DATA_HOME ?? p.join(homedir, ".local", "share");

  return p.join(base, APP_NAME, "profile");
}
