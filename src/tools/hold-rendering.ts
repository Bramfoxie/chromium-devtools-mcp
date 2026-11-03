import type { DaemonAccess } from "../mcp/index.js";

const SCREENCAST = { format: "jpeg", quality: 1, everyNthFrame: 1000 };

export async function startRendering(
    access: DaemonAccess,
    tab   : string,
): Promise<() => Promise<void>> {
    await access.send(tab, "Page.startScreencast", SCREENCAST).catch(() => undefined);

    return async () => {
        await access.send(tab, "Page.stopScreencast", {}).catch(() => undefined);
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
