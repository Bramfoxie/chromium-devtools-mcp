import { z } from "zod";
import { ErrorCode, RpcError } from "../daemon/index.js";
import { ToolError } from "./errors.js";

export function parseCdp<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);

    if (parsed.success) return parsed.data;

    throw new ToolError(`The browser sent an unexpected response to ${method}. Try the call again.`);
}

export function isCdpError(error: unknown): boolean {
    return error instanceof RpcError && error.code === ErrorCode.cdpError;
}
