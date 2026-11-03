import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    type ArtifactIO,
    DirectoryArtifactStore,
    nodeArtifactIO,
    noArtifacts,
} from "../src/tools/index.js";

const NOW = Date.parse("2026-11-03T12:34:56Z");

interface Written {
    file: string;
    data: string | Uint8Array;
}

function fakeIO(listing: Array<{ name: string; modifiedMs: number }> = []) {
    const written: Written[] = [];
    const removed: string[] = [];
    const calls: string[] = [];
    const io: ArtifactIO = {
        ensureDir: async (dir) => void calls.push(`ensure ${dir}`),
        write    : async (file, data) => void written.push({ file, data }),
        list     : async () => listing,
        remove   : async (file) => void removed.push(file),
    };

    return { io, written, removed, calls };
}

function storeWith(io: ArtifactIO, extra: { maxAgeMs?: number } = {}) {
    return new DirectoryArtifactStore({
        dir   : "/data/artifacts",
        io,
        now   : () => NOW,
        random: () => "0123456789ab",
        ...extra,
    });
}

describe("DirectoryArtifactStore", () => {
    it("writes a file named by kind, time and a random part and reports its size", async () => {
        const { io, written } = fakeIO();
        const result = await storeWith(io).write("trace", "json", "héllo");

        expect(result.path).toBe(path.join("/data/artifacts", "trace-20261103T123456-0123456789ab.json"));
        expect(result.bytes).toBe(6);
        expect(written).toEqual([{ file: result.path, data: "héllo" }]);
    });

    it("counts the bytes of binary data", async () => {
        const { io } = fakeIO();

        expect((await storeWith(io).write("shot", "png", new Uint8Array(10))).bytes).toBe(10);
    });

    it("prepares the directory once and removes only its own files older than a day", async () => {
        const day = 24 * 60 * 60 * 1000;
        const { io, removed, calls } = fakeIO([
            { name: "trace-20261101T000000-aaaaaaaaaaaa.json", modifiedMs: NOW - 2 * day },
            { name: "trace-20261103T100000-bbbbbbbbbbbb.json", modifiedMs: NOW - 1000 },
            { name: "notes.txt", modifiedMs: NOW - 9 * day },
            { name: "trace-bad-name.json", modifiedMs: NOW - 9 * day },
        ]);
        const store = storeWith(io);

        await store.write("trace", "json", "a");
        await store.write("trace", "json", "b");

        expect(calls).toEqual(["ensure /data/artifacts"]);
        expect(removed).toEqual([path.join("/data/artifacts", "trace-20261101T000000-aaaaaaaaaaaa.json")]);
    });

    it.each([
        ["Trace", "json"],
        ["../trace", "json"],
        ["trace", "J.son"],
        ["tra ce", "json"],
        ["", "json"],
    ])("refuses the name %s.%s", async (kind, extension) => {
        const { io, written } = fakeIO();

        await expect(storeWith(io).write(kind, extension, "x")).rejects.toThrow(/lowercase letters/);
        expect(written).toEqual([]);
    });

    it("explains a directory that cannot be prepared and tries again next time", async () => {
        let attempts = 0;
        const { io } = fakeIO();
        const store = storeWith({
            ...io,
            ensureDir: async () => {
                attempts += 1;

                if (attempts === 1) throw new Error("EACCES");
            },
        });

        await expect(store.write("trace", "json", "x")).rejects.toThrow(/Could not prepare the directory/);
        await expect(store.write("trace", "json", "x")).resolves.toBeDefined();
    });

    it("explains a file that cannot be written", async () => {
        const { io } = fakeIO();
        const store = storeWith({
            ...io,
            write: async () => {
                throw new Error("ENOSPC");
            },
        });

        await expect(store.write("trace", "json", "x")).rejects.toThrow(/Could not write .*ENOSPC/);
    });
});

describe("noArtifacts", () => {
    it("says the server cannot save files", async () => {
        await expect(noArtifacts.write("trace", "json", "x")).rejects.toThrow(/no directory for files/);
    });
});

describe("nodeArtifactIO on a real directory", () => {
    let dir: string | undefined;

    afterEach(async () => {
        if (dir !== undefined) await rm(dir, { recursive: true, force: true });

        dir = undefined;
    });

    it("writes a private file, refuses to overwrite and lists and removes files", async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), "cdm-artifacts-"));
        const target = path.join(dir, "artifacts");
        const io = nodeArtifactIO(process.platform, process.getuid?.());
        const store = new DirectoryArtifactStore({ dir: target, io, maxAgeMs: 1000 });
        const old = path.join(target, "trace-20200101T000000-aaaaaaaaaaaa.json");
        const foreign = path.join(target, "keep.txt");

        await io.ensureDir(target);
        await writeFile(old, "old");
        await writeFile(foreign, "mine");
        await utimes(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
        await utimes(foreign, new Date(2020, 0, 1), new Date(2020, 0, 1));

        const written = await store.write("trace", "json", '{"a":1}');

        expect(await readFile(written.path, "utf8")).toBe('{"a":1}');

        if (process.platform !== "win32") {
            expect((await stat(written.path)).mode & 0o777).toBe(0o600);
            expect((await stat(target)).mode & 0o777).toBe(0o700);
        }

        await expect(io.write(written.path, "again")).rejects.toThrow(/EEXIST/);
        await expect(stat(old)).rejects.toThrow();
        expect(await readFile(foreign, "utf8")).toBe("mine");
    });
});
