import { z } from "zod";
import { RpcError } from "./errors.js";
import { quoted } from "../util/log.js";
import { normalizeUrl } from "./method-policy.js";
import { ErrorCode } from "./protocol.js";
import { requestParamSchemas } from "./wire.js";
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
    stop(): void;
}

type Method = keyof typeof requestParamSchemas;

function isMethod(name: string): name is Method {
    return Object.hasOwn(requestParamSchemas, name);
}

type Params<M extends Method> = z.infer<(typeof requestParamSchemas)[M]>;

function parseParams<M extends Method>(method: M, params: unknown): Params<M> {
    const result = requestParamSchemas[method].safeParse(params ?? {});

    if (result.success) return result.data as Params<M>;

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

        if (method === "daemon.stop") {
            parseParams(method, params);
            context.stop();

            return {};
        }

        const registry = context.registry();

        if (!registry) {
            throw new RpcError(
                ErrorCode.browserNotReady,
                context.status().message ?? "The browser is not ready yet. Try again in a moment.",
            );
        }

        if (method === "session.open") {
            const { isolated, safety } = parseParams(method, params);
            const session = await registry.open(
                connection,
                (event, eventParams) => connection.sendEvent(event, eventParams),
                {
                    isolated  : isolated ?? false,
                    clientName: connection.clientName,
                    ...(safety === undefined ? {} : { safety }),
                },
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
            case "permission.set": {
                await session.setPermission(parseParams(method, params));

                return {};
            }

            case "tab.create": {
                const { url } = parseParams(method, params);

                return { targetId: await session.createTab(normalizeUrl(url ?? "about:blank")) };
            }

            case "tab.list": {
                const { scope } = parseParams(method, params);

                return { tabs: await session.listTabs(scope ?? "owned") };
            }

            case "window.get": {
                return session.getWindow(parseParams(method, params).targetId);
            }

            case "popup.list": {
                return { tabs: await session.listPopups(parseParams(method, params).targetId) };
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

                return session.send({
                    targetId : request.targetId,
                    method   : request.method,
                    params   : request.params,
                    timeoutMs: request.timeoutMs,
                    frameId  : request.frameId,
                    confirmed: request.confirmed,
                });
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
