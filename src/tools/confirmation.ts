import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { DaemonAccess } from "../mcp/index.js";

export type ConfirmOutcome = "accepted" | "declined" | "unsupported" | "failed";

export interface ConfirmRequest {
    tool   : string;
    summary: string;
}

export type Confirmer = (request: ConfirmRequest, signal: AbortSignal) => Promise<ConfirmOutcome>;

const CONFIRM_TIMEOUT_MS = 300_000;

export function elicitationConfirmer(server: Server): Confirmer {
    return async (request, signal) => {
        if (server.getClientCapabilities()?.elicitation === undefined) return "unsupported";

        try {
            const answer = await server.elicitInput(
                {
                    mode           : "form",
                    message        : `Allow ${request.tool}? ${request.summary}`,
                    requestedSchema: { type: "object", properties: {} },
                },
                { signal, timeout: CONFIRM_TIMEOUT_MS },
            );

            return answer.action === "accept" ? "accepted" : "declined";
        } catch {
            return "failed";
        }
    };
}

export function confirmedAccess(access: DaemonAccess): DaemonAccess {
    return new Proxy(access, {
        get(target, property) {
            if (property === "send") {
                return (
                    tab       : string,
                    method    : string,
                    params?   : Record<string, unknown>,
                    timeoutMs?: number,
                    frame?    : string,
                    options?  : { signal?: AbortSignal },
                ) => target.send(tab, method, params, timeoutMs, frame, {
                    ...options,
                    confirmed: true,
                });
            }

            const value: unknown = Reflect.get(target, property, target);

            return typeof value === "function"
                ? (value as (...args: unknown[]) => unknown).bind(target)
                : value;
        },
    });
}

export function confirmationRefusal(
    tool   : string,
    outcome: Exclude<ConfirmOutcome, "accepted">,
): string {
    switch (outcome) {
        case "declined":
            return `${tool} was not confirmed by the user, so it did not run.`;

        case "failed":
            return `${tool} could not be confirmed because the confirmation request failed, so it did not run. Call the tool again to ask once more.`;

        case "unsupported":
            return `${tool} is a dangerous action and safety.confirmDangerous is on, but this client cannot ask the user for confirmation. Ask the owner to set safety.confirmDangerous to false, or to use a client that supports confirmation.`;
    }
}
