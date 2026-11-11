import { mkdtemp, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openUploadSource, UPLOAD_SOURCE_MAX_BYTES } from "../src/daemon/upload-source.js";

describe("verified upload sources", () => {
    it("reads the opened file even if the original path is replaced", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-source-"));
        const file = path.join(dir, "file.txt");
        const saved = path.join(dir, "saved.txt");

        try {
            await writeFile(file, "original");
            const source = await openUploadSource(file, process.platform);

            try {
                expect(path.normalize(source.path).toLowerCase())
                    .toBe(path.normalize(await realpath(file)).toLowerCase());
                await rename(file, saved);
                await writeFile(file, "replacement");
                const buffer = Buffer.alloc(100);
                const count = await source.read(buffer);

                expect(buffer.subarray(0, count).toString()).toBe("original");
                expect(await readFile(file, "utf8")).toBe("replacement");
            } finally {
                await source.close();
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("refuses directories and files over the upload size limit", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-source-"));
        const large = path.join(dir, "large.txt");

        try {
            await mkdir(path.join(dir, "folder"));
            const file = await open(large, "w");

            await file.truncate(UPLOAD_SOURCE_MAX_BYTES + 1);
            await file.close();
            await expect(openUploadSource(path.join(dir, "folder"), process.platform)).rejects.toThrow();
            await expect(openUploadSource(large, process.platform)).rejects.toThrow();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
