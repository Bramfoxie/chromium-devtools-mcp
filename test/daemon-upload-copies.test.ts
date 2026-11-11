import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareUploadCopies } from "../src/daemon/upload-copies.js";

describe("private upload copies", () => {
    it("preserves the name and contents after the source changes", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-copy-"));
        const allowed = path.join(dir, "allowed");
        const storage = path.join(dir, "copies");
        const file = path.join(allowed, "sample.txt");

        try {
            await mkdir(allowed);
            await writeFile(file, "original");
            const originalTime = (await stat(file)).mtimeMs;
            const prepared = await prepareUploadCopies(
                [file], [await realpath(allowed)], storage, process.platform,
            );

            try {
                const copy = prepared.files[0];

                expect(copy?.size).toBe(8);
                expect(path.basename(copy?.path ?? "")).toBe("sample.txt");
                expect(Math.abs((await stat(copy?.path ?? "")).mtimeMs - originalTime)).toBeLessThan(2);
                await writeFile(file, "replacement");
                expect(await readFile(copy?.path ?? "", "utf8")).toBe("original");
            } finally {
                await prepared.discard();
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform === "win32")("refuses a link to a file outside the allowed directory", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-copy-"));
        const allowed = path.join(dir, "allowed");
        const outside = path.join(dir, "secret.txt");

        try {
            await mkdir(allowed);
            await writeFile(outside, "secret");
            await symlink(outside, path.join(allowed, "link.txt"));
            await expect(prepareUploadCopies(
                [path.join(allowed, "link.txt")], [await realpath(allowed)], path.join(dir, "copies"), process.platform,
            )).rejects.toThrow();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("stops copying and removes the partial copy after cancellation", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-copy-"));
        const allowed = path.join(dir, "allowed");
        const storage = path.join(dir, "copies");
        let cancelled = false;
        let closed = false;
        let reads = 0;

        try {
            await mkdir(allowed);
            const file = path.join(await realpath(allowed), "file.txt");
            const source = async () => ({
                path   : file, size   : 4, mtimeMs: Date.now(),
                read   : async (buffer: Buffer) => {
                    reads += 1;
                    buffer.write("data");
                    cancelled = true;

                    return 4;
                },
                close: async () => { closed = true; },
            });

            await expect(prepareUploadCopies(
                [file], [await realpath(allowed)], storage, process.platform,
                () => cancelled, source,
            )).rejects.toThrow("cancelled");
            expect(reads).toBe(1);
            expect(closed).toBe(true);
            expect(await readdir(path.join(storage, "upload-staging"))).toEqual([]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("retains active copies and removes expired released copies on a later upload", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-copy-"));
        const allowed = path.join(dir, "allowed");
        const storage = path.join(dir, "copies");
        const file = path.join(allowed, "sample.txt");
        const old = new Date(Date.now() - 48 * 60 * 60 * 1000);

        try {
            await mkdir(allowed);
            await writeFile(file, "original");
            const roots = [await realpath(allowed)];
            const first = await prepareUploadCopies([file], roots, storage, process.platform);
            const copy = first.files[0]?.path ?? "";
            const batch = path.dirname(path.dirname(copy));

            await utimes(batch, old, old);
            const second = await prepareUploadCopies([file], roots, storage, process.platform);

            expect(await readFile(copy, "utf8")).toBe("original");
            await first.release();
            await utimes(batch, old, old);
            const third = await prepareUploadCopies([file], roots, storage, process.platform);

            await expect(stat(copy)).rejects.toThrow();
            await second.discard();
            await third.discard();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("does not delete an unmarked directory during cleanup", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-copy-"));
        const allowed = path.join(dir, "allowed");
        const storage = path.join(dir, "copies");
        const foreign = path.join(storage, "upload-staging", `upload-${"a".repeat(24)}`);
        const old = new Date(Date.now() - 48 * 60 * 60 * 1000);

        try {
            await mkdir(allowed);
            await mkdir(foreign, { recursive: true });
            await writeFile(path.join(foreign, "keep.txt"), "keep");
            await utimes(foreign, old, old);
            const file = path.join(allowed, "sample.txt");

            await writeFile(file, "original");
            const copy = await prepareUploadCopies(
                [file], [await realpath(allowed)], storage, process.platform,
            );

            expect(await readFile(path.join(foreign, "keep.txt"), "utf8")).toBe("keep");
            await copy.discard();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
