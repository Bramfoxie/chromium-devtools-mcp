import type { DaemonAccess, DaemonFrame } from "../mcp/index.js";
import { ToolError } from "./errors.js";

export const FRAME_EVENTS = [
    "Page.frameAttached",
    "Page.frameNavigated",
    "Page.frameDetached",
] as const;

const MAX_DISCOVERY_ATTEMPTS = 3;

class FrameTreeChangedError extends ToolError {}

export interface FrameInfo {
    frameId       : string;
    parentFrameId?: string | undefined;
    url           : string;
    name          : string;
    isolated      : boolean;
    truncated?    : boolean | undefined;
}

interface TabFrames {
    ensured     : boolean;
    subscribed  : Set<string>;
    frames      : Map<string, FrameInfo>;
    mainFrameId : string | undefined;
    generations : Map<string, number>;
    sequence    : number;
    applied     : number;
    eventVersion: number;
    appliedEvent: number;
}

type FrameNavigatedListener = (tab: string, frameId: string, main: boolean) => void;

interface FrameStateOptions {
    access: DaemonAccess;
}

function parseFrameEvent(
    params: unknown,
): { frameId: string; parent?: string; url?: string; name?: string } | undefined {
    const envelope = params as {
        targetId?: unknown;
        event?   : unknown;
        params?  : unknown;
    } | null;

    if (typeof envelope?.targetId !== "string" || typeof envelope.event !== "string") {
        return undefined;
    }

    const body = envelope.params as {
        frameId?: unknown;
        frame?  : { id?: unknown; parentId?: unknown; url?: unknown; name?: unknown };
    } | null;
    const frameId = typeof body?.frameId === "string"
        ? body.frameId
        : typeof body?.frame?.id === "string"
            ? body.frame.id
            : undefined;

    if (frameId === undefined) return undefined;

    const parent = typeof body?.frame?.parentId === "string" ? body.frame.parentId : undefined;

    return {
        frameId,
        parent,
        ...(typeof body?.frame?.url === "string" ? { url: body.frame.url } : {}),
        ...(typeof body?.frame?.name === "string" ? { name: body.frame.name } : {}),
    };
}

export class FrameState {
    private readonly access   : DaemonAccess;
    private readonly tabs = new Map<string, TabFrames>();
    private readonly navigated: FrameNavigatedListener[] = [];
    private attached = false;

    constructor(options: FrameStateOptions) {
        this.access = options.access;
    }

    attach(): void {
        if (this.attached) return;

        this.attached = true;
        this.access.on("cdp.event", (params) => this.handleCdpEvent(params));
    }

    onNavigated(listener: FrameNavigatedListener): void {
        this.navigated.push(listener);
    }

    ensured(tab: string): boolean {
        return this.tabs.get(tab)?.ensured ?? false;
    }

    async ensure(tab: string): Promise<void> {
        const state = this.state(tab);

        if (!state.ensured) {
            try {
                await this.discover(tab, state);
            } catch (error) {
                this.assertCurrent(tab, state);
                if (error instanceof FrameTreeChangedError) throw error;
            }

            this.assertCurrent(tab, state);
            state.ensured = true;
        }

        for (const event of FRAME_EVENTS) {
            if (state.subscribed.has(event)) continue;

            await this.access.subscribe(tab, event);
            this.assertCurrent(tab, state);
            state.subscribed.add(event);
        }
    }

    framesOf(tab: string): FrameInfo[] {
        return [...(this.tabs.get(tab)?.frames.values() ?? [])];
    }

    mainFrame(tab: string): string | undefined {
        return this.tabs.get(tab)?.mainFrameId;
    }

    frameOf(tab: string, frameId: string): FrameInfo | undefined {
        return this.tabs.get(tab)?.frames.get(frameId);
    }

    generation(tab: string, frameId: string): number {
        return this.tabs.get(tab)?.generations.get(frameId) ?? 0;
    }

    async refresh(tab: string): Promise<FrameInfo[]> {
        const state = this.state(tab);

        await this.discover(tab, state);

        return this.framesOf(tab);
    }

    async resolve(tab: string, frame: string): Promise<FrameInfo> {
        const state = this.state(tab);

        const direct = state.frames.get(frame);

        if (direct !== undefined) return direct;

        const refreshed = await this.refresh(tab);
        const found = refreshed.find((info) => info.frameId === frame);

        if (found !== undefined) return found;

        throw new ToolError(
            `No frame ${JSON.stringify(frame)} exists in this tab. List frames with dom_snapshot and try again.`,
        );
    }

    forget(tab: string): void {
        this.tabs.delete(tab);
    }

    reset(): void {
        this.tabs.clear();
    }

    handleCdpEvent(params: unknown): void {
        const envelope = params as { targetId?: unknown; event?: unknown } | null;

        if (typeof envelope?.targetId !== "string" || typeof envelope.event !== "string") return;

        const state = this.tabs.get(envelope.targetId);

        if (state === undefined) return;

        const parsed = parseFrameEvent(params);

        if (parsed === undefined) return;

        if (envelope.event === "Page.frameDetached" || envelope.event === "Page.frameNavigated"
            || envelope.event === "Page.frameAttached") {
            state.eventVersion += 1;
        }

        if (envelope.event === "Page.frameDetached") {
            state.frames.delete(parsed.frameId);
            state.generations.set(parsed.frameId, (state.generations.get(parsed.frameId) ?? 0) + 1);

            return;
        }

        if (envelope.event === "Page.frameNavigated") {
            state.generations.set(parsed.frameId, (state.generations.get(parsed.frameId) ?? 0) + 1);

            const known = state.frames.get(parsed.frameId);

            if (known !== undefined) {
                state.frames.set(parsed.frameId, {
                    ...known,
                    ...(parsed.url === undefined ? {} : { url: parsed.url }),
                    ...(parsed.name === undefined ? {} : { name: parsed.name }),
                });
            }

            for (const listener of this.navigated) {
                listener(envelope.targetId, parsed.frameId, parsed.parent === undefined);
            }

            return;
        }

        if (envelope.event === "Page.frameAttached" && parsed.parent !== undefined) {
            const known = state.frames.get(parsed.frameId);

            state.frames.set(parsed.frameId, known ?? {
                frameId      : parsed.frameId,
                parentFrameId: parsed.parent,
                url          : "",
                name         : "",
                isolated     : false,
            });
        }
    }

    private state(tab: string): TabFrames {
        let state = this.tabs.get(tab);

        if (!state) {
            state = {
                ensured     : false,
                subscribed  : new Set(),
                frames      : new Map(),
                mainFrameId : undefined,
                generations : new Map(),
                sequence    : 0,
                applied     : 0,
                eventVersion: 0,
                appliedEvent: 0,
            };
            this.tabs.set(tab, state);
        }

        return state;
    }

    private assertCurrent(tab: string, state: TabFrames): void {
        if (this.tabs.get(tab) !== state) {
            throw new ToolError("The tab closed or the session reset while loading frames.");
        }
    }

    private async discover(tab: string, state: TabFrames): Promise<void> {
        for (let attempt = 0; attempt < MAX_DISCOVERY_ATTEMPTS; attempt += 1) {
            const sequence = ++state.sequence;
            const eventVersion = state.eventVersion;
            const frames = await this.access.listFrames(tab);

            this.assertCurrent(tab, state);
            if (state.applied > sequence && state.appliedEvent === state.eventVersion) return;
            if (state.eventVersion !== eventVersion) continue;
            if (sequence < state.applied) return;

            state.applied = sequence;
            state.appliedEvent = eventVersion;
            this.replace(tab, frames);

            return;
        }

        throw new FrameTreeChangedError("The frame tree kept changing while it was being read. Try again.");
    }

    private replace(tab: string, frames: DaemonFrame[]): void {
        const state = this.state(tab);
        const seen = new Set(frames.map((frame) => frame.frameId));

        for (const frameId of [...state.frames.keys()]) {
            if (!seen.has(frameId)) {
                state.frames.delete(frameId);
                state.generations.set(frameId, (state.generations.get(frameId) ?? 0) + 1);
            }
        }

        for (const frame of frames) {
            state.frames.set(frame.frameId, { ...frame });
        }

        state.mainFrameId = frames.find((frame) => frame.parentFrameId === undefined)?.frameId ??
            frames[0]?.frameId;
    }
}
