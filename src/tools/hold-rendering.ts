import type { DaemonAccess } from "../mcp/index.js";

const SCREENCAST_QUALITY = 1;
const SCREENCAST_EVERY_NTH_FRAME = 1000;
const SCREENCAST = {
    format       : "jpeg",
    quality      : SCREENCAST_QUALITY,
    everyNthFrame: SCREENCAST_EVERY_NTH_FRAME,
};

export interface RecordingParams {
    format       : "jpeg";
    quality      : number;
    maxWidth     : number;
    everyNthFrame: number;
}

interface TabRendering {
    holds    : number;
    recording: boolean;
    running  : boolean;
}

const states = new WeakMap<DaemonAccess, Map<string, TabRendering>>();

function stateOf(access: DaemonAccess, tab: string): TabRendering {
    const perTab = states.get(access) ?? new Map<string, TabRendering>();

    states.set(access, perTab);

    const known = perTab.get(tab);

    if (known !== undefined) return known;

    const fresh: TabRendering = { holds: 0, recording: false, running: false };

    perTab.set(tab, fresh);

    return fresh;
}

function forgetIfIdle(access: DaemonAccess, tab: string, state: TabRendering): void {
    if (state.holds === 0 && !state.recording) states.get(access)?.delete(tab);
}

async function begin(
    access: DaemonAccess,
    tab   : string,
    params: Record<string, unknown>,
): Promise<void> {
    await access.send({
        targetId: tab,
        method  : "Page.startScreencast",
        params,
    });
}

async function halt(access: DaemonAccess, tab: string): Promise<void> {
    await access.send({
        targetId: tab,
        method  : "Page.stopScreencast",
        params  : {},
    }).catch(() => undefined);
}

// A tab has one screencast. Holds only keep the page rendering and are counted; a recording
// takes the screencast over with its own settings and gives it back to the holds when it ends.
export async function startRendering(
    access: DaemonAccess,
    tab   : string,
): Promise<() => Promise<void>> {
    const state = stateOf(access, tab);

    state.holds += 1;

    if (!state.running) {
        state.running = true;
        await begin(access, tab, SCREENCAST).catch(() => undefined);
    }

    let released = false;

    return async () => {
        if (released) return;

        released = true;
        state.holds -= 1;

        if (state.holds === 0 && !state.recording && state.running) {
            state.running = false;
            await halt(access, tab);
        }

        forgetIfIdle(access, tab, state);
    };
}

export async function startRecording(
    access: DaemonAccess,
    tab   : string,
    params: RecordingParams,
): Promise<() => Promise<void>> {
    const state = stateOf(access, tab);

    if (state.running) await halt(access, tab);

    state.recording = true;
    state.running = true;

    try {
        await begin(access, tab, { ...params });
    } catch (error) {
        state.recording = false;
        state.running = false;

        if (state.holds > 0) {
            state.running = true;
            await begin(access, tab, SCREENCAST).catch(() => undefined);
        }

        forgetIfIdle(access, tab, state);

        throw error;
    }

    let ended = false;

    return async () => {
        if (ended) return;

        ended = true;
        state.recording = false;
        await halt(access, tab);
        state.running = false;

        if (state.holds > 0) {
            state.running = true;
            await begin(access, tab, SCREENCAST).catch(() => undefined);
        }

        forgetIfIdle(access, tab, state);
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
