import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir } from "../daemon/index.js";
import { ToolError } from "./errors.js";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const NAME_PART = /^[a-z0-9-]+$/;

const FILE_NAME = /^[a-z0-9-]+(\.[a-z0-9]+)?$/;

const OWN_ENTRY = /^[a-z0-9-]+-\d{8}T\d{6}-[0-9a-f]{12}(\.[a-z0-9]+)?$/;

export interface ArtifactFile {
    path : string;
    bytes: number;
}

export interface ArtifactDirectory {
    path: string;
    write(name: string, data: string | Uint8Array): Promise<number>;
    remove(name: string): Promise<void>;
}

export interface ArtifactStore {
    write(kind: string, extension: string, data: string | Uint8Array): Promise<ArtifactFile>;
    directory(kind: string): Promise<ArtifactDirectory>;
}

export interface ArtifactIO {
    ensureDir(dir: string): Promise<void>;
    makeDir(dir: string): Promise<void>;
    write(file: string, data: string | Uint8Array): Promise<void>;
    list(dir: string): Promise<Array<{ name: string; modifiedMs: number }>>;
    remove(file: string): Promise<void>;
}

export interface DirectoryStoreOptions {
    dir      : string;
    io?      : ArtifactIO;
    now?     : () => number;
    random?  : () => string;
    maxAgeMs?: number;
}

export function nodeArtifactIO(platform: NodeJS.Platform, uid: number | undefined): ArtifactIO {
    return {
        ensureDir: (dir) => ensurePrivateDir(dir, platform, uid),
        makeDir  : (dir) => mkdir(dir, { mode: 0o700 }),
        write    : (file, data) => writeFile(file, data, { mode: 0o600, flag: "wx" }),
        list     : async (dir) => {
            const names = await readdir(dir);

            return Promise.all(
                names.map(async (name) => ({
                    name,
                    modifiedMs: (await stat(path.join(dir, name))).mtimeMs,
                })),
            );
        },
        remove: (file) => rm(file, { recursive: true, force: true }),
    };
}

function stamp(ms: number): string {
    return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace(/Z$/, "");
}

// Writes files into one private directory and removes its own files that are older than a day.
export class DirectoryArtifactStore implements ArtifactStore {
    private readonly io      : ArtifactIO;
    private readonly now     : () => number;
    private readonly random  : () => string;
    private readonly maxAgeMs: number;
    private prepared         : Promise<void> | undefined;

    constructor(private readonly options: DirectoryStoreOptions) {
        this.io = options.io ?? nodeArtifactIO(process.platform, process.getuid?.());
        this.now = options.now ?? (() => Date.now());
        this.random = options.random ?? (() => randomBytes(6).toString("hex"));
        this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    }

    async write(kind: string, extension: string, data: string | Uint8Array): Promise<ArtifactFile> {
        if (!NAME_PART.test(kind) || !NAME_PART.test(extension)) {
            throw new ToolError("The file name of an artifact may use lowercase letters, digits and dashes only.");
        }

        const file = path.join(await this.ready(), this.entryName(kind, `.${extension}`));

        try {
            await this.io.write(file, data);
        } catch (error) {
            throw new ToolError(`Could not write ${file}: ${reason(error)}`);
        }

        return { path: file, bytes: typeof data === "string" ? Buffer.byteLength(data) : data.byteLength };
    }

    async directory(kind: string): Promise<ArtifactDirectory> {
        if (!NAME_PART.test(kind)) {
            throw new ToolError("The name of an artifact may use lowercase letters, digits and dashes only.");
        }

        const dir = path.join(await this.ready(), this.entryName(kind, ""));

        try {
            await this.io.makeDir(dir);
        } catch (error) {
            throw new ToolError(`Could not create ${dir}: ${reason(error)}`);
        }

        const inside = (name: string): string => {
            if (!FILE_NAME.test(name)) {
                throw new ToolError("The file name of an artifact may use lowercase letters, digits, dashes and one extension only.");
            }

            return path.join(dir, name);
        };

        return {
            path : dir,
            write: async (name, data) => {
                const file = inside(name);

                try {
                    await this.io.write(file, data);
                } catch (error) {
                    throw new ToolError(`Could not write ${file}: ${reason(error)}`);
                }

                return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
            },
            remove: async (name) => this.io.remove(inside(name)),
        };
    }

    private entryName(kind: string, suffix: string): string {
        return `${kind}-${stamp(this.now())}-${this.random()}${suffix}`;
    }

    private async ready(): Promise<string> {
        this.prepared ??= this.prepare();

        try {
            await this.prepared;
        } catch (error) {
            this.prepared = undefined;

            throw new ToolError(
                `Could not prepare the directory ${this.options.dir} for files: ${reason(error)}`,
            );
        }

        return this.options.dir;
    }

    private async prepare(): Promise<void> {
        await this.io.ensureDir(this.options.dir);
        const cutoff = this.now() - this.maxAgeMs;

        for (const entry of await this.io.list(this.options.dir)) {
            if (OWN_ENTRY.test(entry.name) && entry.modifiedMs < cutoff) {
                const file = path.join(this.options.dir, entry.name);

                await this.io.remove(file).catch(() => undefined);
            }
        }
    }
}

function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const NO_DIRECTORY = "This server has no directory for files, so it cannot save one.";

export const noArtifacts: ArtifactStore = {
    write    : () => Promise.reject(new ToolError(NO_DIRECTORY)),
    directory: () => Promise.reject(new ToolError(NO_DIRECTORY)),
};
