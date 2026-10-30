import type net from "node:net";
import { ProtocolViolationError, RpcError } from "./errors.js";
import { describeError, logDaemon, quoted } from "./log.js";
import {
  encodeMessage,
  ErrorCode,
  helloParamsSchema,
  LineDecoder,
  parseLine,
  requestSchema,
} from "./protocol.js";
import { tokensMatch } from "./token.js";

const DEFAULT_HELLO_TIMEOUT_MS = 5000;
const MAX_IN_FLIGHT = 64;
const MAX_WRITE_BUFFER_BYTES = 8 * 1024 * 1024;
const INTERNAL_MESSAGE = "The daemon failed to handle the request.";
const TOO_LARGE_MESSAGE = "The result is larger than the 1 MiB limit of the daemon protocol.";

export interface ClientConnection {
  readonly clientName: string;
  sendEvent(event: string, params?: unknown): void;
  close(): void;
}

export interface IncomingRequest {
  method: string;
  params: unknown;
}

export type RequestHandler = (
  request: IncomingRequest,
  connection: ClientConnection,
) => Promise<unknown>;

export interface AcceptOptions {
  token: string;
  handler: RequestHandler;
  helloTimeoutMs?: number;
  helloResult?: () => unknown;
  onReady?: (connection: ClientConnection) => void;
  onClose?: (connection: ClientConnection) => void;
}

function guarded(label: string, action: (() => void) | undefined): void {
  try {
    action?.();
  } catch (error) {
    logDaemon(`${label} failed: ${describeError(error)}`);
  }
}

export function acceptConnection(socket: net.Socket, options: AcceptOptions): void {
  const decoder = new LineDecoder();
  let connection: ClientConnection | undefined;
  let inFlight = 0;

  socket.on("error", () => undefined);

  const write = (message: unknown) => {
    if (socket.destroyed || !socket.writable) return;
    socket.write(encodeMessage(message));
    if (socket.writableLength > MAX_WRITE_BUFFER_BYTES) {
      logDaemon("dropped a client that does not read its messages");
      socket.destroy();
    }
  };

  const reply = (id: number, outcome: { result: unknown } | { error: RpcError }) => {
    const message =
      "error" in outcome
        ? { id, error: { code: outcome.error.code, message: outcome.error.message } }
        : { id, result: outcome.result };
    try {
      write(message);
    } catch (error) {
      logDaemon(`could not encode a response: ${describeError(error)}`);
      const tooLarge = error instanceof ProtocolViolationError;
      guarded("reply", () =>
        write({
          id,
          error: tooLarge
            ? { code: ErrorCode.resultTooLarge, message: TOO_LARGE_MESSAGE }
            : { code: ErrorCode.internal, message: INTERNAL_MESSAGE },
        }),
      );
    }
  };

  const reject = (reason: string) => {
    logDaemon(`rejected a daemon connection: ${reason}`);
    socket.destroy();
  };

  const helloTimer = setTimeout(
    () => reject("no hello in time"),
    options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
  );
  socket.once("close", () => {
    clearTimeout(helloTimer);
    const closing = connection;
    if (closing) guarded("onClose", () => options.onClose?.(closing));
  });

  const authenticate = (line: string): boolean => {
    const parsed = requestSchema.safeParse(parseLine(line));
    if (!parsed.success || parsed.data.method !== "hello") {
      reject("the first message is not a hello");
      return false;
    }
    const params = helloParamsSchema.safeParse(parsed.data.params);
    if (!params.success || !tokensMatch(options.token, params.data.token)) {
      reject("invalid hello");
      return false;
    }
    clearTimeout(helloTimer);
    const ready: ClientConnection = {
      clientName: params.data.clientName,
      sendEvent: (event, eventParams) => {
        try {
          write({ event, params: eventParams });
        } catch (error) {
          logDaemon(`could not encode event ${quoted(event)}: ${describeError(error)}`);
        }
      },
      close: () => socket.destroy(),
    };
    connection = ready;
    reply(parsed.data.id, { result: { ok: true, daemon: options.helloResult?.() } });
    guarded("onReady", () => options.onReady?.(ready));
    return true;
  };

  const run = (id: number, method: string, params: unknown, active: ClientConnection) => {
    if (inFlight >= MAX_IN_FLIGHT) {
      reply(id, { error: new RpcError(ErrorCode.busy, "Too many requests are in progress.") });
      return;
    }
    inFlight += 1;
    Promise.resolve()
      .then(() => options.handler({ method, params }, active))
      .then(
        (result) => reply(id, { result }),
        (error: unknown) => {
          if (error instanceof RpcError) {
            reply(id, { error });
            return;
          }
          logDaemon(`request ${quoted(method)} failed: ${describeError(error)}`);
          reply(id, { error: new RpcError(ErrorCode.internal, INTERNAL_MESSAGE) });
        },
      )
      .finally(() => {
        inFlight -= 1;
      })
      .catch((error: unknown) => {
        logDaemon(`request ${quoted(method)} could not be answered: ${describeError(error)}`);
      });
  };

  const dispatch = (line: string, active: ClientConnection) => {
    const raw = parseLine(line);
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) {
      const id = (raw as { id?: unknown } | null)?.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) {
        throw new RpcError(ErrorCode.badRequest, "The request is malformed.");
      }
      reply(id, { error: new RpcError(ErrorCode.badRequest, "The request is malformed.") });
      return;
    }
    const { id, method, params } = parsed.data;
    if (method === "hello") {
      reply(id, { error: new RpcError(ErrorCode.badRequest, "The connection is already open.") });
      return;
    }
    run(id, method, params, active);
  };

  socket.on("data", (chunk: Buffer) => {
    try {
      for (const line of decoder.push(chunk)) {
        if (!connection) {
          if (!authenticate(line)) return;
        } else {
          dispatch(line, connection);
        }
      }
    } catch (error) {
      reject(error instanceof Error ? error.message : "protocol error");
    }
  });
}
