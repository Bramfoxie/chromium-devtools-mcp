import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
    CallToolResult,
    ServerNotification,
    ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { AnyTool } from "./define-tool.js";
import { ToolRuntime } from "./context.js";
import { ToolError, toToolMessage } from "./errors.js";
import { errorResult, jsonResult } from "./result.js";
import { checkSafety } from "./safety.js";

export const CANCELLED_MESSAGE = "The request was cancelled. Call the tool again if needed.";

export interface RegisterToolsOptions {
    server : McpServer;
    tools  : AnyTool[];
    runtime: ToolRuntime;
}

export function throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new ToolError(CANCELLED_MESSAGE);
}

export function registerTools(options: RegisterToolsOptions): void {
    for (const tool of options.tools) {
        const input = tool.input;
        const output = tool.announced ?? tool.output;

        options.server.registerTool(
            tool.name,
            { description: tool.description, inputSchema: input, outputSchema: output },
            (async (
                args : Record<string, unknown>,
                extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
            ): Promise<CallToolResult> => runTool(tool, args, extra, options.runtime)) as never,
        );
    }
}

export async function runTool(
    tool   : AnyTool,
    rawArgs: unknown,
    extra  : RequestHandlerExtra<ServerRequest, ServerNotification>,
    runtime: ToolRuntime,
): Promise<CallToolResult> {
    const parsed = tool.input.safeParse(rawArgs ?? {});

    if (!parsed.success) {
        return errorResult(`Invalid arguments for ${tool.name}: ${parsed.error.message}`);
    }

    if (extra.signal.aborted) return errorResult(CANCELLED_MESSAGE);

    const decision = checkSafety({
        tool  : tool.name,
        access: tool.access,
        config: runtime.config,
        target: tool.target?.(parsed.data),
    });

    if (!decision.allowed) return errorResult(`${decision.reason} ${decision.hint}`);

    try {
        const output = await tool.handler(parsed.data, runtime.context(extra.signal));

        throwIfCancelled(extra.signal);
        const validated = tool.output.safeParse(output);

        if (!validated.success) {
            return errorResult(`The tool ${tool.name} returned an invalid result. Try the call again.`);
        }

        const value = validated.data as Record<string, unknown>;

        if (tool.present) return tool.present(validated.data);

        return jsonResult(value);
    } catch (error) {
        if (extra.signal.aborted) return errorResult(CANCELLED_MESSAGE);

        return errorResult(toToolMessage(error));
    }
}
