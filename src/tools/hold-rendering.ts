import type { DaemonAccess } from "../mcp/index.js";

const SCREENCAST_QUALITY = 1;
const SCREENCAST_EVERY_NTH_FRAME = 1000;
const SCREENCAST = {
    format       : "jpeg",
    quality      : SCREENCAST_QUALITY,
    everyNthFrame: SCREENCAST_EVERY_NTH_FRAME,
};

const holds = new WeakMap<DaemonAccess, Map<string, number>>();

// Holds of one tab are counted, so the rendering stops only when the last of them lets go.
export async function startRendering(
    access: DaemonAccess,
    tab   : string,
): Promise<() => Promise<void>> {
    const perTab = holds.get(access) ?? new Map<string, number>();
    const held = perTab.get(tab) ?? 0;

    holds.set(access, perTab);
    perTab.set(tab, held + 1);

    if (held === 0) {
        await access.send({
            targetId: tab,
            method  : "Page.startScreencast",
            params  : SCREENCAST,
        }).catch(() => undefined);
    }

    let released = false;

    return async () => {
        if (released) return;

        released = true;
        const left = (perTab.get(tab) ?? 1) - 1;

        if (left > 0) {
            perTab.set(tab, left);

            return;
        }

        perTab.delete(tab);
        await access.send({
            targetId: tab,
            method  : "Page.stopScreencast",
            params  : {},
        }).catch(() => undefined);
    };
}

export async function holdRendering<T>(
    access: DaemonAccess,
    tab   : string,
    run   : () => Promise<T>,
): Promise<T> {
    const release = await startRendering(access, tab);

    try {
        return await run();
    } finally {
        await release();
    }
}
