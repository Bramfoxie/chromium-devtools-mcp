export interface CdpEnvelope {
    targetId: string;
    event   : string;
    params  : unknown;
}

export function parseEnvelope(value: unknown): CdpEnvelope | undefined {
    const envelope = value as {
        targetId?: unknown;
        event?   : unknown;
        params?  : unknown;
    } | null;

    if (typeof envelope?.targetId !== "string") return undefined;
    if (typeof envelope.event !== "string") return undefined;

    return { targetId: envelope.targetId, event: envelope.event, params: envelope.params };
}
