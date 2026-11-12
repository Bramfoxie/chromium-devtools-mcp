import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pinUploadRoots } from "../src/daemon/upload-roots.js";

describe("pinned upload directories", () => {
    it("uses another root when one cannot be opened", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-root-"));
        const allowed = path.join(dir, "allowed");

        try {
            await mkdir(allowed);
            const roots = await pinUploadRoots([path.join(dir, "missing"), allowed], process.platform);

            try {
                expect(roots).toHaveLength(1);
            } finally {
                await Promise.all(roots.map(async (root) => root.close()));
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("opens from the original directory after its name is replaced", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-root-"));
        const allowed = path.join(dir, "allowed");
        const outside = path.join(dir, "outside");
        const saved = path.join(dir, "saved");
        let close = async () => {};

        try {
            await mkdir(allowed);
            await mkdir(outside);
            await writeFile(path.join(allowed, "file"), "original");
            await writeFile(path.join(outside, "file"), "secret");
            const roots = await pinUploadRoots([allowed], process.platform);
            const root = roots[0];

            if (root === undefined) throw new Error("No pinned root.");

            close = async () => root.close();
            await rename(allowed, saved);
            await rename(outside, allowed);
            const source = await root.open("file");

            try {
                const buffer = Buffer.alloc(32);
                const length = await source.read(buffer);

                expect(buffer.subarray(0, length).toString()).toBe("original");
            } finally {
                await source.close();
            }
        } finally {
            await close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("refuses an intermediate directory link", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-root-"));
        const allowed = path.join(dir, "allowed");
        const outside = path.join(dir, "outside");
        let close = async () => {};

        try {
            await mkdir(allowed);
            await mkdir(outside);
            await writeFile(path.join(outside, "file"), "secret");
            await symlink(outside, path.join(allowed, "link"), process.platform === "win32" ? "junction" : "dir");
            const roots = await pinUploadRoots([allowed], process.platform);
            const root = roots[0];

            if (root === undefined) throw new Error("No pinned root.");

            close = async () => root.close();
            await expect(root.open(path.join("link", "file"))).rejects.toThrow();
        } finally {
            await close();
            await rm(dir, { recursive: true, force: true });
        }
    });
});
