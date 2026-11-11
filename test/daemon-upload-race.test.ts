import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NO_SAFETY } from "../src/daemon/cdp-safety.js";
import { SessionRegistry } from "../src/daemon/sessions.js";
import { FakeBackend } from "./helpers/fake-backend.js";

describe("upload directory race", () => {
    it("does not send a file replaced after the directory check", async () => {
        const temporary = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-race-"));
        const allowed = path.join(await realpath(temporary), "allowed");
        const outside = path.join(await realpath(temporary), "outside");
        const inside = path.join(allowed, "inside");
        const saved = path.join(allowed, "saved");
        const file = path.join(inside, "sample.txt");
        const backend = new FakeBackend();
        let replaced = false;

        try {
            await mkdir(allowed);
            await mkdir(inside);
            await mkdir(outside);
            await writeFile(file, "allowed");
            await writeFile(path.join(outside, "sample.txt"), "secret");
            const registry = new SessionRegistry<string>(backend, {
                allowFocus       : false, downloadsRoot    : path.join(temporary, "copies"),
                resolveUploadPath: async (value) => {
                    const resolved = await realpath(value);

                    if (value === file && !replaced) {
                        replaced = true;
                        await rename(inside, saved);
                        await symlink(outside, inside, process.platform === "win32" ? "junction" : "dir");
                    }

                    return resolved;
                },
            });
            const session = await registry.open("a", () => undefined, {
                isolated: false, clientName: "a", safety: { ...NO_SAFETY, uploadDirs: [allowed] },
            });

            await expect(session.prepareUploads({
                ticket: "a".repeat(32), files: [file],
            })).rejects.toThrow("safety.uploadDirs");
            await session.close();
        } finally {
            await rm(temporary, { recursive: true, force: true });
        }
    });

    it("does not accept a replacement of the allowed directory itself", async () => {
        const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "cdm-upload-race-")));
        const allowed = path.join(temporary, "allowed");
        const saved = path.join(temporary, "saved");
        const outside = path.join(temporary, "outside");
        const file = path.join(allowed, "sample.txt");
        let close: () => Promise<void> = async () => undefined;

        try {
            await mkdir(allowed);
            await mkdir(outside);
            await writeFile(file, "allowed");
            await writeFile(path.join(outside, "sample.txt"), "secret");
            let replaced = false;
            const registry = new SessionRegistry<string>(new FakeBackend(), {
                allowFocus       : false, downloadsRoot    : path.join(temporary, "copies"),
                resolveUploadPath: async (value) => {
                    const resolved = await realpath(value);

                    if (value === file && !replaced) {
                        replaced = true;
                        await rename(allowed, saved);
                        await symlink(outside, allowed, process.platform === "win32" ? "junction" : "dir");
                    }

                    return resolved;
                },
            });
            const session = await registry.open("a", () => undefined, {
                isolated: false, clientName: "a", safety: { ...NO_SAFETY, uploadDirs: [allowed] },
            });

            close = async () => session.close();
            await expect(session.prepareUploads({
                ticket: "b".repeat(32), files: [file],
            })).rejects.toThrow("safety.uploadDirs");
        } finally {
            await close();
            await rm(temporary, { recursive: true, force: true });
        }
    });

    it("does not accept a directory renamed over the allowed root", async () => {
        const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "cdm-upload-race-")));
        const allowed = path.join(temporary, "allowed");
        const saved = path.join(temporary, "saved");
        const outside = path.join(temporary, "outside");
        const file = path.join(allowed, "sample.txt");
        let close: () => Promise<void> = async () => undefined;

        try {
            await mkdir(allowed);
            await mkdir(outside);
            await writeFile(file, "allowed");
            await writeFile(path.join(outside, "sample.txt"), "secret");
            let replaced = false;
            const registry = new SessionRegistry<string>(new FakeBackend(), {
                allowFocus       : false, downloadsRoot    : path.join(temporary, "copies"),
                resolveUploadPath: async (value) => {
                    const resolved = await realpath(value);

                    if (value === file && !replaced) {
                        replaced = true;
                        await rename(allowed, saved);
                        await rename(outside, allowed);
                    }

                    return resolved;
                },
            });
            const session = await registry.open("a", () => undefined, {
                isolated: false, clientName: "a", safety: { ...NO_SAFETY, uploadDirs: [allowed] },
            });

            close = async () => session.close();
            await expect(session.prepareUploads({
                ticket: "b".repeat(32), files: [file],
            })).rejects.toThrow("safety.uploadDirs");
        } finally {
            await close();
            await rm(temporary, { recursive: true, force: true });
        }
    });

    it("does not accept a root replaced while its path is resolved", async () => {
        const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "cdm-upload-race-")));
        const allowed = path.join(temporary, "allowed");
        const saved = path.join(temporary, "saved");
        const outside = path.join(temporary, "outside");
        const file = path.join(allowed, "sample.txt");
        let close: () => Promise<void> = async () => undefined;

        try {
            await mkdir(allowed);
            await mkdir(outside);
            await writeFile(file, "allowed");
            await writeFile(path.join(outside, "sample.txt"), "secret");
            let replaced = false;
            const registry = new SessionRegistry<string>(new FakeBackend(), {
                allowFocus       : false, downloadsRoot    : path.join(temporary, "copies"),
                resolveUploadPath: async (value) => {
                    const resolved = await realpath(value);

                    if (value === allowed && !replaced) {
                        replaced = true;
                        await rename(allowed, saved);
                        await rename(outside, allowed);
                    }

                    return resolved;
                },
            });
            const session = await registry.open("a", () => undefined, {
                isolated: false, clientName: "a", safety: { ...NO_SAFETY, uploadDirs: [allowed] },
            });

            close = async () => session.close();
            await expect(session.prepareUploads({
                ticket: "c".repeat(32), files: [file],
            })).rejects.toThrow("safety.uploadDirs");
        } finally {
            await close();
            await rm(temporary, { recursive: true, force: true });
        }
    });
});
