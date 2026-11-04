import { describeError, logDaemon } from "../util/log.js";

export type PermissionName = "geolocation";

export interface PermissionGrant {
    name     : PermissionName;
    origin   : string;
    contextId: string | undefined;
}

export interface PermissionBackend {
    setPermission(grant: PermissionGrant): Promise<void>;
    resetPermissions(contextId: string | undefined): Promise<void>;
}

interface Entry {
    grant  : PermissionGrant;
    holders: Set<object>;
}

function keyOf(grant: PermissionGrant): string {
    return `${grant.contextId ?? ""}|${grant.name}|${grant.origin}`;
}

// Counts the holders of an override and removes it when the last one lets go.
export class PermissionLedger {
    private readonly entries = new Map<string, Entry>();
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly backend: PermissionBackend) {}

    private serial<T>(work: () => Promise<T>): Promise<T> {
        const run = this.queue.then(work, work);

        this.queue = run.catch(() => undefined);

        return run;
    }

    grant(holder: object, grant: PermissionGrant): Promise<void> {
        return this.serial(() => this.doGrant(holder, grant));
    }

    release(holder: object, grant: PermissionGrant): Promise<void> {
        return this.serial(() => this.doRelease(holder, grant));
    }

    releaseAll(holder: object, disposedContextId?: string): Promise<void> {
        return this.serial(() => this.doReleaseAll(holder, disposedContextId));
    }

    private async doGrant(holder: object, grant: PermissionGrant): Promise<void> {
        await this.backend.setPermission(grant);
        const key = keyOf(grant);
        const entry = this.entries.get(key) ?? { grant, holders: new Set() };

        entry.holders.add(holder);
        this.entries.set(key, entry);
    }

    private async doRelease(holder: object, grant: PermissionGrant): Promise<void> {
        const key = keyOf(grant);
        const entry = this.entries.get(key);

        if (entry === undefined || !entry.holders.delete(holder)) return;

        if (entry.holders.size > 0) return;

        this.entries.delete(key);
        await this.rebuild(grant.contextId);
    }

    // A disposed context takes its overrides with it, so it needs no reset.
    private async doReleaseAll(holder: object, disposedContextId?: string): Promise<void> {
        const contexts = new Set<string | undefined>();

        for (const [key, entry] of [...this.entries]) {
            if (!entry.holders.delete(holder) || entry.holders.size > 0) continue;

            this.entries.delete(key);

            if (entry.grant.contextId !== disposedContextId || disposedContextId === undefined) {
                contexts.add(entry.grant.contextId);
            }
        }

        for (const contextId of contexts) await this.rebuild(contextId);
    }

    private async rebuild(contextId: string | undefined): Promise<void> {
        try {
            await this.backend.resetPermissions(contextId);

            for (const { grant } of this.entries.values()) {
                if (grant.contextId === contextId) await this.backend.setPermission(grant);
            }
        } catch (error) {
            logDaemon(`could not reset the browser permissions: ${describeError(error)}`);
        }
    }
}
