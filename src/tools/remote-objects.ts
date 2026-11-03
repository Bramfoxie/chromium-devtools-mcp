import type { DaemonAccess } from "../mcp/index.js";

export async function releaseQuietly(
    access   : DaemonAccess,
    tab      : string,
    objectIds: Array<string | undefined>,
): Promise<void> {
    for (const objectId of objectIds) {
        if (objectId === undefined) continue;

        await access.send(tab, "Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
}

export async function releaseGroupQuietly(
    access     : DaemonAccess,
    tab        : string,
    objectGroup: string,
): Promise<void> {
    await access.send(tab, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
}
