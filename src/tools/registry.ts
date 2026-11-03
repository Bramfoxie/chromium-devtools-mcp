import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
    CallToolResult,
    ServerNotification,
    ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { AnyTool } from "./define-tool.js";
import { ToolRuntime } from "./context.js";
import { admit } from "./gate.js";
import { ToolError, toToolMessage } from "./errors.js";
import { errorResult, jsonResult } from "./result.js";
import { logDaemon } from "../daemon/log.js";
import { SessionResetError } from "../mcp/index.js";

export const CANCELLED_MESSAGE = "The request was cancelled. Call the tool again if needed.";

const CANCELLED_MUTATING_MESSAGE =
    "The request was cancelled while the tool was running, so its change may already have been applied. Check the page with page_info or dom_query before calling the tool again.";

interface RegisterToolsOptions {
    server : McpServer;
    tools  : AnyTool[];
    runtime: ToolRuntime;
}

export function throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new ToolError(CANCELLED_MESSAGE);
}

export function toolAnnotations(tool: AnyTool): {
    title          : string;
    readOnlyHint   : boolean;
    destructiveHint: boolean;
    openWorldHint  : boolean;
} {
    const mutate = typeof tool.access === "function" ? true : tool.access === "mutate";
    const dangerous = typeof tool.dangerous === "function" ? true : (tool.dangerous ?? false);

    return {
        title          : tool.name,
        readOnlyHint   : !mutate,
        destructiveHint: dangerous,
        openWorldHint  : tool.closedWorld !== true,
    };
}

function raceWithSignal<T>(work: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
    if (signal.aborted) return Promise.reject(new ToolError(message));

    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new ToolError(message));

        signal.addEventListener("abort", onAbort, { once: true });
        work.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

export function registerTools(options: RegisterToolsOptions): void {
    for (const tool of options.tools) {
        const input = tool.input;
        const output = tool.announced ?? tool.output;

        options.server.registerTool(
            tool.name,
            {
                description : tool.description,
                inputSchema : input,
                outputSchema: output,
                annotations : toolAnnotations(tool),
            },
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

    const verdict = admit(tool, parsed.data, extra.signal, runtime);
    const admission = verdict instanceof Promise ? await verdict : verdict;

    if (!admission.admitted) return errorResult(admission.message);

    const generation = runtime.access.sessionGeneration;

    try {
        const output = await raceWithSignal(
            tool.handler(parsed.data, runtime.context(extra.signal, admission.confirmed)),
            extra.signal,
            (typeof tool.access === "function" ? tool.access(parsed.data) : tool.access) === "mutate"
                ? CANCELLED_MUTATING_MESSAGE
                : CANCELLED_MESSAGE,
        );
        const validated = tool.output.safeParse(output);

        if (!validated.success) {
            const paths = validated.error.issues.map((issue) => issue.path.join(".") || "(root)");

            logDaemon(`tool ${tool.name} returned an invalid result at: ${paths.join(", ")}`);

            return errorResult(`The tool ${tool.name} returned an invalid result. Try the call again.`);
        }

        const value = validated.data as Record<string, unknown>;

        if (tool.present) return tool.present(validated.data);

        return jsonResult(value);
    } catch (error) {
        if (error instanceof SessionResetError) return errorResult(error.message);

        if (generation > 0 && runtime.access.sessionGeneration !== generation) {
            return errorResult(new SessionResetError().message);
        }

        return errorResult(toToolMessage(error));
    }
}
