import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir } from "./private-dir.js";
import { openUploadSource, UPLOAD_SOURCE_MAX_BYTES } from "./upload-source.js";
import { logDaemon } from "../util/log.js";
import type { UploadRoot } from "./upload-roots.js";

const COPY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const COPY_CHUNK_BYTES = 64 * 1024;
const COPY_DIR = /^upload-[0-9a-f]{24}$/;
const active = new Set<string>();

export interface UploadCopies {
    files: Array<{ path: string; size: number }>;
    release(): Promise<void>;
    discard(): Promise<void>;
}

async function prune(root: string, now: number): Promise<void> {
    const entries = await readdir(root).catch(() => []);

    for (const entry of entries) {
        if (!COPY_DIR.test(entry)) continue;

        const dir = path.join(root, entry);

        if (active.has(dir)) continue;

        try {
            const info = await lstat(dir);

            if (!info.isDirectory() || info.isSymbolicLink() ||
                now - info.mtimeMs < COPY_MAX_AGE_MS) continue;

            const marker = await lstat(path.join(dir, ".upload-copy"));

            if (!marker.isFile() || marker.isSymbolicLink()) continue;

            await rm(dir, { recursive: true, force: true });
        } catch {
        }
    }
}

function inside(platform: NodeJS.Platform, root: string, file: string): boolean {
    const paths = platform === "win32" ? path.win32 : path.posix;
    const relative = paths.relative(root, file);

    return relative !== "" && relative !== ".." && !relative.startsWith(`..${paths.sep}`) &&
        !paths.isAbsolute(relative);
}

export async function prepareUploadCopies(
    files: string[], roots: string[], directory: string, platform: NodeJS.Platform,
    cancelled: () => boolean = () => false,
    openSource: typeof openUploadSource = openUploadSource,
    pinned?: UploadRoot[],
): Promise<UploadCopies> {
    if (files.length === 0 || files.length > 20) throw new Error("Invalid files.");

    const paths = platform === "win32" ? path.win32 : path.posix;

    if (roots.length === 0) throw new Error("No allowed directory can be resolved.");

    if (cancelled()) throw new Error("Upload preparation cancelled.");

    await ensurePrivateDir(directory, platform, process.getuid?.());
    const staging = path.join(directory, "upload-staging");

    await ensurePrivateDir(staging, platform, process.getuid?.());
    await prune(staging, Date.now());
    const batch = path.join(staging, `upload-${randomBytes(12).toString("hex")}`);

    await mkdir(batch, { mode: 0o700 });
    active.add(batch);
    let retained = false;

    try {
        await writeFile(path.join(batch, ".upload-copy"), "", { mode: 0o600, flag: "wx" });
        const copies: UploadCopies["files"] = [];

        for (const [index, file] of files.entries()) {
            if (cancelled()) throw new Error("Upload preparation cancelled.");
            if (!paths.isAbsolute(file)) throw new Error("Invalid path.");

            const resolved = pinned === undefined ? undefined : await realpath(file);
            const anchor = resolved === undefined ? undefined
                : pinned?.find((root) => inside(platform, root.path, resolved));

            if (pinned !== undefined && (anchor === undefined || resolved === undefined)) {
                throw new Error("Outside the allowed directories.");
            }

            const source = anchor === undefined || resolved === undefined
                ? await openSource(file, platform)
                : await anchor.open(paths.relative(anchor.path, resolved));

            try {
                if (!roots.some((root) => inside(platform, root, source.path))) {
                    throw new Error("Outside the allowed directories.");
                }

                const child = path.join(batch, String(index));

                await mkdir(child, { mode: 0o700 });
                const destination = path.join(child, paths.basename(file));
                const output = await open(destination, "wx", 0o600);
                let size = 0;

                try {
                    const buffer = Buffer.alloc(COPY_CHUNK_BYTES);

                    for (;;) {
                        if (cancelled()) throw new Error("Upload preparation cancelled.");

                        const count = await source.read(buffer);

                        if (count < 0 || count > buffer.length) throw new Error("Invalid read size.");
                        if (count === 0) break;

                        size += count;
                        if (size > UPLOAD_SOURCE_MAX_BYTES) throw new Error("File is too large.");

                        let offset = 0;

                        while (offset < count) {
                            const wrote = await output.write(buffer, offset, count - offset);

                            if (wrote.bytesWritten <= 0) throw new Error("Cannot write copy.");

                            offset += wrote.bytesWritten;
                        }
                    }

                    const modified = new Date(source.mtimeMs);

                    await output.utimes(modified, modified);
                } finally {
                    await output.close();
                }

                copies.push({ path: destination, size });
            } finally {
                await source.close();
            }
        }

        if (cancelled()) throw new Error("Upload preparation cancelled.");

        retained = true;

        return {
            files  : copies,
            release: async () => {
                const now = new Date();

                await utimes(batch, now, now);
                active.delete(batch);
            },
            discard: async () => {
                active.delete(batch);
                await rm(batch, { recursive: true, force: true });
            },
        };
    } finally {
        if (!retained) {
            active.delete(batch);
            await rm(batch, { recursive: true, force: true }).catch(() =>
                logDaemon("could not remove incomplete upload copies"));
        }
    }
}
