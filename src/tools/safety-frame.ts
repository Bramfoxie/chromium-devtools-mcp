import type { ElementRegistry } from "./element-target.js";
import type { FrameState } from "./frames.js";
import { originOfUrl } from "../safety/index.js";
import type { SafetyFrame } from "./safety.js";

interface FrameBearer {
    frame?: unknown;
    uid?  : unknown;
}

const NESTED_KEYS = ["target", "root", "from", "to"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function bearers(args: unknown): FrameBearer[] {
    if (!isRecord(args)) return [];

    const nested = NESTED_KEYS.map((key) => args[key]).filter(isRecord);
    const fields = Array.isArray(args.fields)
        ? args.fields.filter(isRecord).map((field) => field.target).filter(isRecord)
        : [];

    return [args, ...nested, ...fields];
}

function frameRefOf(
    bearer  : FrameBearer,
    tab     : string,
    elements: ElementRegistry,
): string | undefined {
    if (typeof bearer.frame === "string" && bearer.frame !== "") return bearer.frame;

    if (typeof bearer.uid === "string") return elements.lookup(tab, bearer.uid)?.frameId;

    return undefined;
}

const INHERITING = new Set(["about:blank", "about:srcdoc"]);

// A frame that inherits its origin is judged by the nearest ancestor with an address of its own.
export function safetyFrameOf(
    frames : Pick<FrameState, "frameOf">,
    tab    : string,
    frameId: string,
): SafetyFrame | undefined {
    let info = frames.frameOf(tab, frameId);
    const seen = new Set<string>();

    while (info !== undefined && INHERITING.has(info.url) && info.parentFrameId !== undefined) {
        if (seen.has(info.frameId)) return undefined;

        seen.add(info.frameId);
        info = frames.frameOf(tab, info.parentFrameId);
    }

    if (info === undefined) return undefined;

    const origin = originOfUrl(info.url);

    return { frameId, url: info.url, ...(origin === undefined ? {} : { origin }) };
}

export async function safetyFramesOf(
    args    : unknown,
    tab     : string,
    elements: ElementRegistry,
    frames  : FrameState,
): Promise<SafetyFrame[]> {
    const refs = [
        ...new Set(
            bearers(args)
                .map((bearer) => frameRefOf(bearer, tab, elements))
                .filter((ref): ref is string => ref !== undefined),
        ),
    ];

    if (refs.length === 0) return [];

    if (!frames.ensured(tab)) await frames.ensure(tab);

    return refs.flatMap((ref) => {
        if (frames.frameOf(tab, ref) === undefined) return [];

        const frame = safetyFrameOf(frames, tab, ref);

        if (frame === undefined) throw new Error(`Frame ${ref} could not be placed.`);

        return [frame];
    });
}
