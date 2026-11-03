import type { ElementRegistry } from "./element-target.js";
import type { FrameState } from "./frames.js";
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

function originOf(url: string): string | undefined {
    try {
        const origin = new URL(url).origin;

        return origin === "null" ? undefined : origin;
    } catch {
        return undefined;
    }
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

    return refs.map((ref) => {
        const info = frames.frameOf(tab, ref);

        if (info === undefined) throw new Error(`Frame ${ref} is not known.`);

        const origin = originOf(info.url);

        return {
            frameId: info.frameId,
            url    : info.url,
            ...(origin === undefined ? {} : { origin }),
        };
    });
}
