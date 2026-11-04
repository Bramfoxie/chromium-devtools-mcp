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
    delivered: boolean;
}

interface TabDownloads {
    directory?: string;
    entries   : Map<string, Entry>;
    waiters   : Set<() => void>;
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

export class DownloadState {
    private readonly tabs = new Map<string, TabDownloads>();
    private readonly subscribed = new Map<string, Set<string>>();
    private attached = false;

    constructor(
        private readonly access: DaemonAccess,
        private readonly files : DownloadFiles = nodeDownloadFiles,
    ) {}

    attach(): void {
        if (this.attached) return;

        this.attached = true;
        this.access.on("cdp.event", (params) => void this.handle(params));
    }

    async subscribe(tab: string): Promise<void> {
        const done = this.subscribed.get(tab) ?? new Set<string>();

        for (const event of EVENTS) {
            if (done.has(event)) continue;

            await this.access.subscribe(tab, event);
            done.add(event);
        }

        this.subscribed.set(tab, done);
    }

    allow(tab: string, directory: string): void {
        this.state(tab).directory = directory;
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
            await new Promise<void>((resolve) => {
                const wake = (): void => {
                    state.waiters.delete(wake);
                    resolve();
                };

                state.waiters.add(wake);
                void sleep(timeoutMs).then(wake);
            });
            found = ready();
        }

        if (found === undefined) return undefined;

        found.delivered = true;

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

        if (entry.state === "completed") await this.locate(state, entry);

        if (entry.state !== "inProgress") for (const wake of [...state.waiters]) wake();
    }

    private async locate(state: TabDownloads, entry: Entry): Promise<void> {
        if (state.directory === undefined) return;

        const claimed = new Set(
            [...state.entries.values()].flatMap((other) =>
                other.path === undefined ? [] : [other.path]),
        );
        const names = await this.files.list(state.directory).catch(() => [] as string[]);
        const free = names
            .filter((name) => !name.endsWith(".crdownload"))
            .map((name) => path.join(state.directory as string, name))
            .filter((file) => !claimed.has(file));
        const exact = path.join(state.directory, entry.filename);
        const chosen = free.includes(exact) ? exact : free.length === 1 ? free[0] : undefined;

        if (chosen === undefined) return;

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
