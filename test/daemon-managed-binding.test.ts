import { mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findManagedBrowser, prepareManagedProfile, rememberManagedBrowser } from "../src/daemon/managed-binding.js";

const settings = { browser: "chrome" as const, headless: true };
const endpoint = "ws://127.0.0.1:9222/devtools/browser/known";

describe("managed browser binding", () => {
    it("does not record a browser against a profile replaced during launch", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "cdm-managed-binding-"));
        const profile = path.join(root, "profile");
        const options = { directory: path.join(root, "private"), platform: process.platform, uid: process.getuid?.() };

        try {
            const original = await prepareManagedProfile(profile);

            await rename(profile, path.join(root, "moved"));
            await mkdir(profile);
            await expect(rememberManagedBrowser(profile, endpoint, settings, options, original))
                .rejects.toThrow();
            expect(await findManagedBrowser(profile, settings, options)).toBeUndefined();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("reuses only the same profile directory and browser", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "cdm-managed-binding-"));
        const profile = path.join(root, "profile");
        const copied = path.join(root, "copied");
        const moved = path.join(root, "moved");
        const options = { directory: path.join(root, "private"), platform: process.platform, uid: process.getuid?.() };

        try {
            await mkdir(profile);
            await mkdir(copied);
            const extendedSettings = { ...settings, secret: "not for storage" };

            await rememberManagedBrowser(
                profile, endpoint, extendedSettings, options, await prepareManagedProfile(profile),
            );
            const [file] = await readdir(options.directory);

            expect(file).toBeDefined();
            const stored = await readFile(path.join(options.directory, file ?? ""), "utf8");

            expect(stored).not.toContain("not for storage");
            expect(await findManagedBrowser(profile, settings, options)).toEqual({
                port: 9222, webSocketUrl: endpoint, source: "managed-binding",
            });
            expect(await findManagedBrowser(copied, settings, options)).toBeUndefined();
            expect(await findManagedBrowser(profile, { ...settings, browser: "edge" }, options)).toBeUndefined();
            const otherMode = await findManagedBrowser(
                profile, { ...settings, headless: false }, options,
            );

            expect(otherMode).toBeDefined();
            await rename(profile, moved);
            await mkdir(profile);
            expect(await findManagedBrowser(profile, settings, options)).toBeUndefined();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("rejects a non-loopback browser endpoint", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "cdm-managed-binding-"));
        const options = { directory: path.join(root, "private"), platform: process.platform, uid: process.getuid?.() };

        try {
            await expect(rememberManagedBrowser(
                root, "ws://example.com:9222/devtools/browser/id", settings, options, await prepareManagedProfile(root),
            )).rejects.toThrow();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
