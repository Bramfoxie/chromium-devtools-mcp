import type { DaemonAccess } from "../mcp/index.js";

const SCREENCAST_QUALITY = 1;
const SCREENCAST_EVERY_NTH_FRAME = 1000;
const SCREENCAST = {
    format       : "jpeg",
    quality      : SCREENCAST_QUALITY,
    everyNthFrame: SCREENCAST_EVERY_NTH_FRAME,
};

export async function startRendering(
    access: DaemonAccess,
    tab   : string,
): Promise<() => Promise<void>> {
    await access.send({
        targetId: tab,
        method  : "Page.startScreencast",
        params  : SCREENCAST,
    }).catch(() => undefined);

    return async () => {
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
