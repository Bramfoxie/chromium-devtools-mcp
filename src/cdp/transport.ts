import WebSocket from "ws";
import { CdpClosedError } from "./errors.js";

const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const CLOSE_GRACE_MS = 1000;

export interface Transport {
  send(data: string): void;
  close(): Promise<void>;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (reason: string) => void): void;
}

export type TransportFactory = (url: string) => Promise<Transport>;

function rawToString(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function wrap(socket: WebSocket): Transport {
  let lastError: string | undefined;
  socket.on("error", (error) => {
    lastError = error.message;
  });
  return {
    send: (data) => socket.send(data),
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        const force = setTimeout(() => socket.terminate(), CLOSE_GRACE_MS);
        socket.once("close", () => {
          clearTimeout(force);
          resolve();
        });
        socket.close();
      }),
    onMessage: (handler) => {
      socket.on("message", (data) => handler(rawToString(data)));
    },
    onClose: (handler) => {
      socket.on("close", (code, reason) => {
        const text = reason.toString("utf8");
        handler(lastError ?? (text === "" ? `socket closed with code ${code}` : text));
      });
    },
  };
}

export const wsTransportFactory: TransportFactory = (url) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      perMessageDeflate: false,
      maxPayload: MAX_PAYLOAD_BYTES,
      followRedirects: false,
    });
    const onError = (error: Error) => {
      reject(
        new CdpClosedError(
          `cannot connect to ${url} (${error.message}). ` +
            "Check that the browser is running with remote debugging enabled",
        ),
      );
    };
    socket.once("error", onError);
    socket.once("open", () => {
      socket.off("error", onError);
      resolve(wrap(socket));
    });
  });
