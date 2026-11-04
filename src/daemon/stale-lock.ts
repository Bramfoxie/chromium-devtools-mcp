import { rm, stat } from "node:fs/promises";

export const STALE_LOCK_MS = 5000;

export async function isFreshLock(dir: string, now: () => number): Promise<boolean> {
    const held = await stat(dir).catch(() => undefined);

    return held !== undefined && now() - held.mtimeMs < STALE_LOCK_MS;
}

export async function removeStaleLock(dir: string, now: () => number): Promise<boolean> {
    if (await isFreshLock(dir, now)) return false;

    await rm(dir, { recursive: true, force: true });

    return true;
}
