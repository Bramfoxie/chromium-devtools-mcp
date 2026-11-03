import type { ElementRegistry } from "./element-target.js";
import type { FrameState } from "./frames.js";
import type { SafetyFrame } from "./safety.js";

interface FrameBearer {
    frame?: unknown;
    uid?  : unknown;
}

function bearers(args: unknown): FrameBearer[] {
    if (typeof args !== "object" || args === null) return [];

    const record = args as Record<string, unknown>;
    const nested = [record.target, record.root].filter(
        (value): value is FrameBearer => typeof value === "object" && value !== null,
    );

    return [record, ...nested];
}

function frameRefOf(
    args    : unknown,
    tab     : string,
    elements: ElementRegistry,
): string | undefined {
    for (const bearer of bearers(args)) {
        if (typeof bearer.frame === "string" && bearer.frame !== "") return bearer.frame;

        if (typeof bearer.uid === "string") {
            const frameId = elements.lookup(tab, bearer.uid)?.frameId;

            if (frameId !== undefined) return frameId;
        }
    }

    return undefined;
}

function originOf(url: string): string | undefined {
    try {
        const origin = new URL(url).origin;

        return origin === "null" ? undefined : origin;
    } catch {
        return undefined;
    }
}

export async function safetyFrameOf(
    args    : unknown,
    tab     : string,
    elements: ElementRegistry,
    frames  : FrameState,
): Promise<SafetyFrame | undefined> {
    const ref = frameRefOf(args, tab, elements);

    if (ref === undefined) return undefined;

    if (!frames.ensured(tab)) await frames.ensure(tab).catch(() => undefined);

    const info = frames.frameOf(tab, ref);

    if (info === undefined) return undefined;

    const origin = originOf(info.url);

    return { frameId: info.frameId, url: info.url, ...(origin === undefined ? {} : { origin }) };
}
