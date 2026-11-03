import { randomBytes } from "node:crypto";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir } from "../daemon/index.js";
import { ToolError } from "./errors.js";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const NAME_PART = /^[a-z0-9-]+$/;

const OWN_FILE = /^[a-z0-9-]+-\d{8}T\d{6}-[0-9a-f]{12}\.[a-z0-9]+$/;

export interface ArtifactFile {
    path : string;
    bytes: number;
}

export interface ArtifactStore {
    write(kind: string, extension: string, data: string | Uint8Array): Promise<ArtifactFile>;
}

export interface ArtifactIO {
    ensureDir(dir: string): Promise<void>;
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
        remove: (file) => rm(file, { force: true }),
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

        this.prepared ??= this.prepare();

        try {
            await this.prepared;
        } catch (error) {
            this.prepared = undefined;

            throw new ToolError(
                `Could not prepare the directory ${this.options.dir} for files: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        const file = path.join(
            this.options.dir,
            `${kind}-${stamp(this.now())}-${this.random()}.${extension}`,
        );

        try {
            await this.io.write(file, data);
        } catch (error) {
            throw new ToolError(
                `Could not write ${file}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        return { path: file, bytes: typeof data === "string" ? Buffer.byteLength(data) : data.byteLength };
    }

    private async prepare(): Promise<void> {
        await this.io.ensureDir(this.options.dir);
        const cutoff = this.now() - this.maxAgeMs;

        for (const entry of await this.io.list(this.options.dir)) {
            if (OWN_FILE.test(entry.name) && entry.modifiedMs < cutoff) {
                const file = path.join(this.options.dir, entry.name);

                await this.io.remove(file).catch(() => undefined);
            }
        }
    }
}

export const noArtifacts: ArtifactStore = {
    write: () =>
        Promise.reject(new ToolError("This server has no directory for files, so it cannot save one.")),
};
