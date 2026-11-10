import { describeError, logDaemon } from "../util/log.js";
import { RpcError } from "./errors.js";
import { ErrorCode } from "./protocol.js";

export type PermissionName = "geolocation" | "notifications" | "camera" | "microphone" | "clipboard-read" | "clipboard-write";

export interface PermissionGrant {
    name     : PermissionName;
    origin   : string;
    contextId: string | undefined;
    setting? : "granted" | "denied";
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
    private readonly pendingCleanup = new Set<string | undefined>();
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
        await this.repair(grant.contextId);
        const key = keyOf(grant);
        const previous = this.entries.get(key);
        const requested = grant.setting ?? "granted";

        if (previous !== undefined && (previous.grant.setting ?? "granted") !== requested &&
            (previous.holders.size > 1 || !previous.holders.has(holder))) {
            throw new RpcError(ErrorCode.busy, "This permission is controlled by another session or tool. Reset it there first.");
        }

        await this.backend.setPermission(grant);
        const entry = previous ?? { grant, holders: new Set() };

        entry.grant = grant;
        entry.holders.add(holder);
        this.entries.set(key, entry);
    }

    private async doRelease(holder: object, grant: PermissionGrant): Promise<void> {
        await this.repair(grant.contextId);
        const key = keyOf(grant);
        const entry = this.entries.get(key);

        if (entry === undefined || !entry.holders.has(holder)) return;

        if (entry.holders.size > 1) {
            entry.holders.delete(holder);

            return;
        }

        this.entries.delete(key);

        try {
            await this.rebuild(grant.contextId);
        } catch (error) {
            this.entries.set(key, entry);

            if (!await this.restore(grant.contextId)) {
                this.pendingCleanup.add(grant.contextId);

                throw new RpcError(ErrorCode.cdpError, "The permission reset failed and some overrides could not be restored. Check the browser permissions and retry.");
            }

            throw error;
        }
    }

    // A disposed context takes its overrides with it, so it needs no reset.
    private async doReleaseAll(holder: object, disposedContextId?: string): Promise<void> {
        const contexts = new Set(this.pendingCleanup);

        if (disposedContextId !== undefined) {
            contexts.delete(disposedContextId);
            this.pendingCleanup.delete(disposedContextId);
        }

        for (const [key, entry] of [...this.entries]) {
            if (!entry.holders.delete(holder) || entry.holders.size > 0) continue;

            this.entries.delete(key);

            if (entry.grant.contextId !== disposedContextId || disposedContextId === undefined) {
                contexts.add(entry.grant.contextId);
            }
        }

        for (const contextId of contexts) {
            try {
                await this.rebuild(contextId);
                this.pendingCleanup.delete(contextId);
            } catch (error) {
                this.pendingCleanup.add(contextId);
                await this.restore(contextId);
                logDaemon(`could not reset the browser permissions: ${describeError(error)}`);
            }
        }
    }

    private async rebuild(contextId: string | undefined): Promise<void> {
        await this.backend.resetPermissions(contextId);

        for (const { grant } of this.entries.values()) {
            if (grant.contextId === contextId) await this.backend.setPermission(grant);
        }
    }

    private async restore(contextId: string | undefined): Promise<boolean> {
        let restored = true;

        for (const { grant } of this.entries.values()) {
            if (grant.contextId !== contextId) continue;

            try {
                await this.backend.setPermission(grant);
            } catch {
                restored = false;
            }
        }

        return restored;
    }

    private async repair(contextId: string | undefined): Promise<void> {
        if (!this.pendingCleanup.has(contextId)) return;

        try {
            await this.rebuild(contextId);
            this.pendingCleanup.delete(contextId);
        } catch {
            await this.restore(contextId);

            throw new RpcError(ErrorCode.cdpError, "Previous permission cleanup is incomplete. Check the browser permissions and retry.");
        }
    }
}
