import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
    vi.doUnmock("koffi");
    vi.resetModules();
});

it("loads without native upload support and refuses restricted preparation", async () => {
    vi.resetModules();
    vi.doMock("koffi", () => { throw new Error("native library unavailable"); });
    const { openUploadSource, UploadSourceUnavailableError } = await import("../src/daemon/upload-source.js");
    const { pinUploadRoots } = await import("../src/daemon/upload-roots.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-optional-"));
    const file = path.join(dir, "file.txt");

    try {
        await writeFile(file, "content");
        await expect(openUploadSource(file, "darwin")).rejects.toBeInstanceOf(UploadSourceUnavailableError);
        await expect(pinUploadRoots([dir], "linux")).rejects.toBeInstanceOf(UploadSourceUnavailableError);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
