import { z } from "zod";
import { RpcError } from "./errors.js";
import { quoted } from "./log.js";
import { normalizeUrl } from "./method-policy.js";
import { ErrorCode } from "./protocol.js";
import type { ClientConnection, RequestHandler } from "./server.js";
import type { ClientSession, SessionRegistry } from "./sessions.js";

export type DaemonState = "starting" | "waiting" | "ready";

export interface DaemonStatus {
    state   : DaemonState;
    browser : string;
    mode    : string;
    message?: string;
}

export interface HandlerContext {
    registry(): SessionRegistry<ClientConnection> | undefined;
    status(): DaemonStatus;
}

const DOMAIN_METHOD = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/;

const targetId = z.string().min(1).max(128);
const frameId = z.string().min(1).max(128);
const domainName = z.string().regex(DOMAIN_METHOD).max(100);

const schemas = {
    "daemon.status": z.strictObject({}),
    "session.open" : z.strictObject({ isolated: z.boolean().optional() }),
    "session.list" : z.strictObject({}),
    "tab.create"   : z.strictObject({ url: z.string().min(1).max(2048).optional() }),
    "tab.list"     : z.strictObject({ scope: z.enum(["owned", "available"]).optional() }),
    "tab.claim"    : z.strictObject({ targetId }),
    "tab.close"    : z.strictObject({ targetId }),
    "frame.list"   : z.strictObject({ targetId }),
    "cdp.send"     : z.strictObject({
        targetId,
        method   : domainName,
        params   : z.record(z.string(), z.unknown()).optional(),
        timeoutMs: z.number().int().min(1).max(300_000).optional(),
        frameId  : frameId.optional(),
    }),
    "cdp.subscribe"  : z.strictObject({ targetId, event: domainName, frameId: frameId.optional() }),
    "cdp.unsubscribe": z.strictObject({ targetId, event: domainName, frameId: frameId.optional() }),
} as const;

type Method = keyof typeof schemas;

function isMethod(name: string): name is Method {
    return Object.hasOwn(schemas, name);
}

function parseParams<M extends Method>(method: M, params: unknown): z.infer<(typeof schemas)[M]> {
    const result = schemas[method].safeParse(params ?? {});

    if (result.success) return result.data as z.infer<(typeof schemas)[M]>;

    const fields = [
        ...new Set(
            result.error.issues.flatMap((issue) =>
                issue.code === "unrecognized_keys"
                    ? issue.keys.map((key) => `unknown field ${quoted(key)}`)
                    : [issue.path.join(".") || "(root)"],
            ),
        ),
    ];

    throw new RpcError(
        ErrorCode.badRequest,
        `Invalid parameters for ${method}: check ${fields.join(", ")}.`,
    );
}

export function createRequestHandler(context: HandlerContext): RequestHandler {
    return async ({ method, params }, connection) => {
        if (!isMethod(method)) {
            throw new RpcError(ErrorCode.unknownMethod, `Unknown method ${method}.`);
        }

        if (method === "daemon.status") {
            parseParams(method, params);

            return context.status();
        }

        const registry = context.registry();

        if (!registry) {
            throw new RpcError(
                ErrorCode.browserNotReady,
                context.status().message ?? "The browser is not ready yet. Try again in a moment.",
            );
        }

        if (method === "session.open") {
            const { isolated } = parseParams(method, params);
            const session = await registry.open(
                connection,
                (event, eventParams) => connection.sendEvent(event, eventParams),
                { isolated: isolated ?? false, clientName: connection.clientName },
            );

            return { isolated: session.isolated };
        }

        const session: ClientSession | undefined = registry.get(connection);

        if (!session) {
            throw new RpcError(ErrorCode.sessionRequired, "Open a session with session.open first.");
        }

        if (method === "session.list") {
            parseParams(method, params);

            return { sessions: registry.listSessions(connection) };
        }

        switch (method) {
            case "tab.create": {
                const { url } = parseParams(method, params);

                return { targetId: await session.createTab(normalizeUrl(url ?? "about:blank")) };
            }

            case "tab.list": {
                const { scope } = parseParams(method, params);

                return { tabs: await session.listTabs(scope ?? "owned") };
            }

            case "tab.claim": {
                await session.claimTab(parseParams(method, params).targetId);

                return {};
            }

            case "tab.close": {
                await session.closeTab(parseParams(method, params).targetId);

                return {};
            }

            case "frame.list": {
                const request = parseParams(method, params);

                return { frames: await session.listFrames(request.targetId) };
            }

            case "cdp.send": {
                const request = parseParams(method, params);

                return session.send(
                    request.targetId,
                    request.method,
                    request.params,
                    request.timeoutMs,
                    request.frameId,
                );
            }

            case "cdp.subscribe": {
                const request = parseParams(method, params);

                await session.subscribe(request.targetId, request.event, request.frameId);

                return {};
            }

            case "cdp.unsubscribe": {
                const request = parseParams(method, params);

                session.unsubscribe(request.targetId, request.event, request.frameId);

                return {};
            }
        }
    };
}
