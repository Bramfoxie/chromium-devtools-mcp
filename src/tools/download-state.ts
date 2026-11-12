import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { redactUrl } from "./capture/redact.js";
import { parseEnvelope } from "./cdp-envelope.js";

export type DownloadStatus = "inProgress" | "completed" | "canceled";

export interface DownloadItem {
    id           : string;
    url          : string;
    filename     : string;
    state        : DownloadStatus;
    receivedBytes: number;
    totalBytes?  : number;
    path?        : string;
}

interface Entry extends DownloadItem {
    delivered : boolean;
    directory?: string;
}

interface TabDownloads {
    directory? : string;
    entries    : Map<string, Entry>;
    waiters    : Set<() => void>;
    changing?  : boolean;
    transition?: boolean;
}

export interface DownloadFiles {
    list(directory: string): Promise<string[]>;
    size(file: string): Promise<number | undefined>;
}

const EVENTS = ["Page.downloadWillBegin", "Page.downloadProgress"] as const;

const willBegin = z.object({
    guid             : z.string(),
    url              : z.string(),
    suggestedFilename: z.string(),
});

const progress = z.object({
    guid         : z.string(),
    totalBytes   : z.number(),
    receivedBytes: z.number(),
    state        : z.enum(["inProgress", "completed", "canceled"]),
});

export const nodeDownloadFiles: DownloadFiles = {
    list: (directory) => readdir(directory),
    size: async (file) => {
        try {
            return (await stat(file)).size;
        } catch {
            return undefined;
        }
    },
};

// The name a page suggests is only a hint: it is cut to its last segment before it is shown.
export function safeFilename(name: string): string {
    const last = name.split(/[\\/]/).pop() ?? "";

    return last.replace(/[\u0000-\u001f]/g, "").slice(0, 255);
}

const LOCATE_ATTEMPTS = 40;

const LOCATE_PAUSE_MS = 50;

const realPause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class DownloadState {
    private readonly tabs = new Map<string, TabDownloads>();
    private readonly subscribed = new Map<string, Set<string>>();
    private attached = false;
    private readonly locating = new Map<string, Promise<void>>();

    constructor(
        private readonly access: DaemonAccess,
        private readonly files : DownloadFiles = nodeDownloadFiles,
        private readonly pause : (ms: number) => Promise<void> = realPause,
    ) {}

    attach(): void {
        if (this.attached) return;

        this.attached = true;
        this.access.on("cdp.event", (params) => void this.handle(params));
    }

    async subscribe(tab: string): Promise<void> {
        const state = this.state(tab);
        const done = this.subscribed.get(tab) ?? new Set<string>();

        this.subscribed.set(tab, done);

        for (const event of EVENTS) {
            if (done.has(event)) continue;

            await this.access.subscribe(tab, event);
            if (this.tabs.get(tab) !== state) return;

            done.add(event);
        }
    }

    allow(tab: string, directory: string): void {
        this.state(tab).directory = directory;
    }

    beginChange(tab: string): {
        current   : () => boolean;
        transition: () => void;
        end       : () => void;
    } | undefined {
        const state = this.state(tab);

        if (state.changing) return undefined;

        state.changing = true;

        return {
            current   : () => this.tabs.get(tab) === state,
            transition: () => { state.transition = true; },
            end       : () => {
                delete state.changing;
                delete state.transition;
            },
        };
    }

    deny(tab: string): void {
        const state = this.tabs.get(tab);

        if (state !== undefined) delete state.directory;
    }

    directoryOf(tab: string): string | undefined {
        return this.tabs.get(tab)?.directory;
    }

    list(tab: string): DownloadItem[] {
        return [...(this.tabs.get(tab)?.entries.values() ?? [])].map(publicItem);
    }

    // The first finished download that was not handed out yet, waiting up to timeoutMs for one.
    async next(
        tab      : string,
        timeoutMs: number,
        sleep    : (ms: number) => Promise<void>,
        id?      : string,
    ): Promise<DownloadItem | undefined> {
        const state = this.state(tab);
        const ready = (): Entry | undefined => {
            const entries = [...state.entries.values()];

            return id === undefined
                ? entries.find((entry) => entry.state !== "inProgress" && !entry.delivered)
                : entries.find((entry) => entry.id === id && entry.state !== "inProgress");
        };
        let found = ready();

        if (found === undefined && timeoutMs > 0) {
            let expired = false;

            void sleep(timeoutMs).then(() => {
                expired = true;

                for (const wake of [...state.waiters]) wake();
            });

            while (found === undefined && !expired) {
                await new Promise<void>((resolve) => {
                    const wake = (): void => {
                        state.waiters.delete(wake);
                        resolve();
                    };

                    state.waiters.add(wake);
                });
                found = ready();
            }
        }

        if (found === undefined) return undefined;

        found.delivered = true;

        if (found.state === "completed" && found.path === undefined) {
            await this.queueLocate(state, found);
        }

        return publicItem(found);
    }

    forget(tab: string): void {
        this.tabs.delete(tab);
        this.subscribed.delete(tab);
    }

    reset(): void {
        this.tabs.clear();
        this.subscribed.clear();
    }

    private state(tab: string): TabDownloads {
        const found = this.tabs.get(tab) ?? { entries: new Map(), waiters: new Set() };

        this.tabs.set(tab, found);

        return found;
    }

    private async handle(params: unknown): Promise<void> {
        const envelope = parseEnvelope(params);

        if (envelope === undefined) return;

        const state = this.tabs.get(envelope.targetId);

        if (state === undefined) return;

        if (envelope.event === "Page.downloadWillBegin") {
            const parsed = willBegin.safeParse(envelope.params);

            if (!parsed.success) return;

            state.entries.set(parsed.data.guid, {
                id           : parsed.data.guid,
                url          : redactUrl(parsed.data.url),
                filename     : safeFilename(parsed.data.suggestedFilename),
                state        : "inProgress",
                receivedBytes: 0,
                delivered    : false,
                ...(state.directory === undefined || state.transition
                    ? {}
                    : { directory: state.directory }),
            });

            return;
        }

        if (envelope.event !== "Page.downloadProgress") return;

        const parsed = progress.safeParse(envelope.params);
        const entry = parsed.success ? state.entries.get(parsed.data.guid) : undefined;

        if (!parsed.success || entry === undefined) return;

        entry.receivedBytes = parsed.data.receivedBytes;
        entry.state = parsed.data.state;

        if (parsed.data.totalBytes > 0) entry.totalBytes = parsed.data.totalBytes;

        if (entry.state === "completed") {
            await this.queueLocate(state, entry);
        }

        if (entry.state !== "inProgress") for (const wake of [...state.waiters]) wake();
    }

    private queueLocate(state: TabDownloads, entry: Entry): Promise<void> {
        const directory = entry.directory;

        if (directory === undefined) return Promise.resolve();

        const turn = (this.locating.get(directory) ?? Promise.resolve()).then(() =>
            entry.path === undefined
                ? this.locate(state, entry, directory)
                : undefined);
        const next = turn.catch(() => undefined);

        this.locating.set(directory, next);
        void next.then(() => {
            if (this.locating.get(directory) === next) this.locating.delete(directory);
        });

        return turn;
    }

    private async choose(
        state    : TabDownloads,
        directory: string,
        entry    : Entry,
    ): Promise<string | undefined | null> {
        const claimed = new Set(
            [...state.entries.values()].flatMap((other) =>
                other.path === undefined ? [] : [other.path]),
        );
        const names = await this.files.list(directory).catch(() => null);

        if (names === null) return null;

        const free = names
            .filter((name) => !name.endsWith(".crdownload"))
            .map((name) => path.join(directory, name))
            .filter((file) => !claimed.has(file));
        const exact = path.join(directory, entry.filename);

        return free.includes(exact) ? exact : free.length === 1 ? free[0] : undefined;
    }

    private async locate(state: TabDownloads, entry: Entry, directory: string): Promise<void> {
        let chosen: string | undefined | null;

        for (let attempt = 0; chosen === undefined && attempt < LOCATE_ATTEMPTS; attempt += 1) {
            if (attempt > 0) await this.pause(LOCATE_PAUSE_MS);

            chosen = await this.choose(state, directory, entry);
        }

        if (chosen === undefined || chosen === null) return;

        entry.path = chosen;

        const size = await this.files.size(chosen);

        if (size !== undefined) entry.receivedBytes = size;
    }
}

function publicItem(entry: Entry): DownloadItem {
    return {
        id           : entry.id,
        url          : entry.url,
        filename     : entry.filename,
        state        : entry.state,
        receivedBytes: entry.receivedBytes,
        ...(entry.totalBytes === undefined ? {} : { totalBytes: entry.totalBytes }),
        ...(entry.path === undefined ? {} : { path: entry.path }),
    };
}
