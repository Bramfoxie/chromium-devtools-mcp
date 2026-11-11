import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { LOOPBACK_HOSTS, BROWSER_PATH_PREFIX, type Config } from "../config/index.js";
import type { AttachEndpoint } from "../browser/attach.js";
import { ensurePrivateDir } from "./private-dir.js";

export interface ManagedBindingOptions {
    directory: string;
    platform : NodeJS.Platform;
    uid      : number | undefined;
}

export interface ProfileIdentity {
    path  : string;
    device: string;
    inode : string;
}

export async function prepareManagedProfile(profile: string): Promise<ProfileIdentity> {
    await mkdir(profile, { recursive: true, mode: 0o700 });

    return profileIdentity(profile);
}

async function profileIdentity(profile: string): Promise<ProfileIdentity> {
    const resolved = await realpath(profile);
    const info = await stat(resolved, { bigint: true });

    if (!info.isDirectory() || info.ino === 0n) throw new Error("Cannot identify managed profile.");

    return { path: resolved, device: String(info.dev), inode: String(info.ino) };
}

function markerFile(directory: string, profile: string): string {
    const name = createHash("sha256").update(profile).digest("hex");

    return path.join(directory, `${name}.json`);
}

function browserEndpoint(value: unknown): AttachEndpoint | undefined {
    if (typeof value !== "string") return undefined;

    try {
        const url = new URL(value);
        const port = Number(url.port);

        if (url.protocol !== "ws:" || !LOOPBACK_HOSTS.has(url.hostname) ||
            !url.pathname.startsWith(BROWSER_PATH_PREFIX) || !Number.isInteger(port) ||
            port < 1 || port > 65535 || url.username || url.password || url.hash || url.search) {
            return undefined;
        }

        return { port, webSocketUrl: value, source: "managed-binding" };
    } catch {
        return undefined;
    }
}

type BrowserSettings = Pick<Config, "browser" | "headless">;

export async function rememberManagedBrowser(
    profile: string, endpoint: string, settings: BrowserSettings, options: ManagedBindingOptions,
    expected: ProfileIdentity,
): Promise<void> {
    const identity = await profileIdentity(profile);

    if (identity.path !== expected.path || identity.device !== expected.device ||
        identity.inode !== expected.inode) {
        throw new Error("The managed profile changed during browser launch.");
    }

    if (browserEndpoint(endpoint) === undefined) throw new Error("Invalid managed browser endpoint.");

    await ensurePrivateDir(options.directory, options.platform, options.uid);
    const file = markerFile(options.directory, identity.path);
    const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;

    try {
        await writeFile(temporary, JSON.stringify({
            ...identity, endpoint, browser: settings.browser, headless: settings.headless,
        }), {
            mode: 0o600, flag: "wx",
        });
        await rename(temporary, file);
    } finally {
        await rm(temporary, { force: true });
    }
}

export async function findManagedBrowser(
    profile: string, settings: BrowserSettings, options: ManagedBindingOptions,
): Promise<AttachEndpoint | undefined> {
    try {
        const identity = await profileIdentity(profile);

        await ensurePrivateDir(options.directory, options.platform, options.uid);
        const file = markerFile(options.directory, identity.path);
        const info = await lstat(file);

        if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) return undefined;
        if (options.platform !== "win32" && ((info.mode & 0o077) !== 0 ||
            (options.uid !== undefined && info.uid !== options.uid))) return undefined;

        const value: unknown = JSON.parse(await readFile(file, "utf8"));

        if (typeof value !== "object" || value === null) return undefined;

        const binding = value as Record<string, unknown>;

        if (binding.path !== identity.path || binding.device !== identity.device ||
            binding.inode !== identity.inode || binding.browser !== settings.browser) {
            return undefined;
        }

        return browserEndpoint(binding.endpoint);
    } catch {
        return undefined;
    }
}
