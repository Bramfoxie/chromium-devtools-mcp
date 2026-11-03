import { z } from "zod";
import { IpcClient } from "./client.js";
import {
    DaemonConfigMismatchError,
    DaemonError,
    DaemonNotRunningError,
    errorCode,
} from "./errors.js";
import { type DaemonIdentity, describeIdentity, differingFields, identitySchema } from "./identity.js";
import { currentLayout, type DaemonLayout } from "./layout.js";
import { readToken } from "./token.js";

const helloSchema = z.object({ daemon: identitySchema });

export interface ConnectToDaemonOptions {
    clientName       : string;
    expect?          : DaemonIdentity;
    layout?          : DaemonLayout;
    connectTimeoutMs?: number;
    requestTimeoutMs?: number;
}

export async function connectToDaemon(options: ConnectToDaemonOptions): Promise<IpcClient> {
    const layout = options.layout ?? currentLayout();
    let token: string | undefined;

    try {
        token = await readToken(layout.tokenFile);
    } catch (error) {
        throw new DaemonError(
            `Cannot read the daemon token file ${layout.tokenFile} (${errorCode(error) ?? "unknown error"}). Check its permissions.`,
        );
    }

    if (!token) throw new DaemonNotRunningError();

    const client = await IpcClient.connect({
        socketPath      : layout.socketPath(token),
        token,
        clientName      : options.clientName,
        connectTimeoutMs: options.connectTimeoutMs,
        requestTimeoutMs: options.requestTimeoutMs,
    });
    const expected = options.expect;

    if (!expected) return client;

    const running = helloSchema.safeParse(client.helloResult);
    const fields = running.success ? differingFields(running.data.daemon, expected) : [];

    if (running.success && fields.length === 0) return client;

    await client.close();

    throw new DaemonConfigMismatchError(
        running.success ? describeIdentity(running.data.daemon, fields) : "an unknown configuration",
        running.success ? describeIdentity(expected, fields) : describeIdentity(expected),
    );
}
