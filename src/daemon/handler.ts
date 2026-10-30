import { z } from "zod";
import { RpcError } from "./errors.js";
import { quoted } from "./log.js";
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

const SAFE_URL_PROTOCOLS = new Set(["http:", "https:"]);
const DOMAIN_METHOD = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/;

const targetId = z.string().min(1).max(128);
const domainName = z.string().regex(DOMAIN_METHOD).max(100);

const schemas = {
  "daemon.status": z.strictObject({}),
  "session.open" : z.strictObject({ isolated: z.boolean().optional() }),
  "tab.create"   : z.strictObject({ url: z.string().min(1).max(2048).optional() }),
  "tab.list"     : z.strictObject({ scope: z.enum(["owned", "available"]).optional() }),
  "tab.claim"    : z.strictObject({ targetId }),
  "tab.close"    : z.strictObject({ targetId }),
  "cdp.send"     : z.strictObject({
    targetId,
    method   : domainName,
    params   : z.record(z.string(), z.unknown()).optional(),
    timeoutMs: z.number().int().min(1).max(300_000).optional(),
  }),
  "cdp.subscribe"  : z.strictObject({ targetId, event: domainName }),
  "cdp.unsubscribe": z.strictObject({ targetId, event: domainName }),
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

function normalizeUrl(url: string): string {
  if (url === "about:blank") return url;

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new RpcError(ErrorCode.unsupportedUrl, "The URL is not valid.");
  }

  if (!SAFE_URL_PROTOCOLS.has(parsed.protocol)) {
    throw new RpcError(
      ErrorCode.unsupportedUrl,
      "Only http, https and about:blank URLs can be opened.",
    );
  }

  return parsed.href;
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
        isolated ?? false,
      );

      return { isolated: session.isolated };
    }

    const session: ClientSession | undefined = registry.get(connection);

    if (!session) {
      throw new RpcError(ErrorCode.sessionRequired, "Open a session with session.open first.");
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

      case "cdp.send": {
        const request = parseParams(method, params);

        return session.send(request.targetId, request.method, request.params, request.timeoutMs);
      }

      case "cdp.subscribe": {
        const request = parseParams(method, params);

        await session.subscribe(request.targetId, request.event);

        return {};
      }

      case "cdp.unsubscribe": {
        const request = parseParams(method, params);

        session.unsubscribe(request.targetId, request.event);

        return {};
      }
    }
  };
}
