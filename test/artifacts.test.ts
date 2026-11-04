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
        makeDir  : async (dir) => void calls.push(`make ${dir}`),
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

    it("still writes when the old files cannot be listed", async () => {
        const { io, written } = fakeIO();

        io.list = async () => {
            throw new Error("EACCES");
        };

        await storeWith(io).write("trace", "json", "x");

        expect(written).toHaveLength(1);
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

describe("DirectoryArtifactStore directories", () => {
    it("creates a directory named by kind, time and a random part and writes files into it", async () => {
        const { io, written, calls } = fakeIO();
        const dir = await storeWith(io).directory("screencast");
        const root = path.join("/data/artifacts", "screencast-20261103T123456-0123456789ab");

        expect(dir.path).toBe(root);
        expect(calls).toEqual(["ensure /data/artifacts", `make ${root}`]);
        await expect(dir.write("frame-0001.jpg", new Uint8Array(7))).resolves.toBe(7);
        await expect(dir.write("frames", "abc")).resolves.toBe(3);
        expect(written.map((entry) => entry.file)).toEqual([
            path.join(root, "frame-0001.jpg"),
            path.join(root, "frames"),
        ]);
    });

    it.each(["../x.jpg", "a/b.jpg", "Frame.jpg", "a.b.c", "", "a b"])(
        "refuses the file name %s inside a directory",
        async (name) => {
            const { io, written } = fakeIO();
            const dir = await storeWith(io).directory("screencast");

            await expect(dir.write(name, "x")).rejects.toThrow(/may use lowercase letters/);
            await expect(dir.remove(name)).rejects.toThrow(/may use lowercase letters/);
            expect(written).toEqual([]);
        },
    );

    it("removes a file of a directory", async () => {
        const { io, removed } = fakeIO();
        const dir = await storeWith(io).directory("screencast");

        await dir.remove("frame-0001.jpg");

        expect(removed).toEqual([path.join(dir.path, "frame-0001.jpg")]);
    });

    it("refuses a bad kind and explains a directory that cannot be created", async () => {
        const { io } = fakeIO();

        await expect(storeWith(io).directory("Bad Kind")).rejects.toThrow(/lowercase letters/);
        await expect(
            storeWith({
                ...io,
                makeDir: async () => {
                    throw new Error("EEXIST");
                },
            }).directory("screencast"),
        ).rejects.toThrow(/Could not create .*EEXIST/);
    });

    it("removes old directories of its own along with old files", async () => {
        const day = 24 * 60 * 60 * 1000;
        const { io, removed } = fakeIO([
            { name: "screencast-20261101T000000-aaaaaaaaaaaa", modifiedMs: NOW - 2 * day },
            { name: "screencast-20261103T100000-bbbbbbbbbbbb", modifiedMs: NOW - 1000 },
            { name: "screencast", modifiedMs: NOW - 9 * day },
        ]);

        await storeWith(io).directory("screencast");

        expect(removed).toEqual([
            path.join("/data/artifacts", "screencast-20261101T000000-aaaaaaaaaaaa"),
        ]);
    });
});

describe("noArtifacts", () => {
    it("says the server cannot save files", async () => {
        await expect(noArtifacts.write("trace", "json", "x")).rejects.toThrow(/no directory for files/);
        await expect(noArtifacts.directory("shots")).rejects.toThrow(/no directory for files/);
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
