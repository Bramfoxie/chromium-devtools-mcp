import WebSocket from "ws";
import { CdpClosedError } from "./errors.js";
import { messageOf } from "../util/message-of.js";

const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const CLOSE_GRACE_MS = 1000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface Transport {
    // Throws synchronously when the socket is not open.
    send(data: string): void;
    close(): Promise<void>;
    onMessage(handler: (data: string) => void): void;
    onClose(handler: (reason: string) => void): void;
}

export type TransportFactory = (url: string, signal?: AbortSignal) => Promise<Transport>;

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
        send : (data) => socket.send(data),
        close: () =>
            new Promise<void>((resolve) => {
                if (socket.readyState === WebSocket.CLOSED) {
                    resolve();

                    return;
                }

                const force = setTimeout(() => socket.terminate(), CLOSE_GRACE_MS);

                force.unref();

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

                handler(
                    text === ""
                        ? (code === 1006 && lastError !== undefined
                            ? lastError
                            : `socket closed with code ${code}`)
                        : text,
                );
            });
        },
    };
}

export function createWsTransportFactory(handshakeTimeoutMs: number): TransportFactory {
    return (url, signal) => connectSocket(url, handshakeTimeoutMs, signal);
}

export const wsTransportFactory: TransportFactory = createWsTransportFactory(HANDSHAKE_TIMEOUT_MS);

function connectSocket(
    url               : string,
    handshakeTimeoutMs: number,
    signal?           : AbortSignal,
): Promise<Transport> {
    return new Promise((resolve, reject) => {
        const fail = (detail: string) =>
            reject(
                new CdpClosedError(
                    `cannot connect to ${url} (${detail}). ` +
            "Check that the browser is running with remote debugging enabled",
                ),
            );
        let socket: WebSocket;

        try {
            socket = new WebSocket(url, {
                perMessageDeflate: false,
                maxPayload       : MAX_PAYLOAD_BYTES,
                followRedirects  : false,
                handshakeTimeout : handshakeTimeoutMs,
            });
        } catch (error) {
            fail(messageOf(error));

            return;
        }

        const budget = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            fail(`opening handshake did not finish within ${handshakeTimeoutMs} ms`);
            socket.terminate();
        }, handshakeTimeoutMs);
        const onAbort = () => {
            clearTimeout(budget);
            fail("the connection attempt was cancelled");
            socket.terminate();
        };
        const onError = (error: Error) => {
            clearTimeout(budget);
            signal?.removeEventListener("abort", onAbort);
            fail(error.message);
            socket.terminate();
        };

        socket.on("error", onError);

        if (signal?.aborted) {
            onAbort();

            return;
        }

        signal?.addEventListener("abort", onAbort, { once: true });
        socket.once("open", () => {
            clearTimeout(budget);
            signal?.removeEventListener("abort", onAbort);
            socket.off("error", onError);
            resolve(wrap(socket));
        });
    });
}
