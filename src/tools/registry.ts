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
import { checkSafety, type SafetyAccess } from "./safety.js";
import { safetyFrameOf } from "./safety-frame.js";
import { SessionResetError } from "../mcp/index.js";

export const CANCELLED_MESSAGE = "The request was cancelled. Call the tool again if needed.";

export interface RegisterToolsOptions {
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
        openWorldHint  : false,
    };
}

function selectedTab(args: unknown, runtime: ToolRuntime): string | undefined {
    const argTab = (args as { tab?: unknown } | null)?.tab;

    if (typeof argTab === "string" && argTab.length > 0) return argTab;

    return runtime.tabs.selected();
}

async function resolveTabUrl(
    tool   : AnyTool,
    args   : unknown,
    runtime: ToolRuntime,
): Promise<string | undefined> {
    const argTab = (args as { tab?: unknown } | null)?.tab;

    if (typeof argTab === "string" && argTab.length > 0) {
        const tabs = await runtime.access.listTabs("owned");
        const known = tabs.find((tab) => tab.targetId === argTab);

        return known?.url;
    }

    if (runtime.tabs.selected() !== undefined) {
        const tabs = await runtime.access.listTabs("owned");
        const known = tabs.find((tab) => tab.targetId === runtime.tabs.selected());

        return known?.url;
    }

    return undefined;
}

function raceWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new ToolError(CANCELLED_MESSAGE));

    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new ToolError(CANCELLED_MESSAGE));

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

    const access: SafetyAccess = typeof tool.access === "function"
        ? (tool.access as (args: unknown) => SafetyAccess)(parsed.data)
        : tool.access;
    const dangerous = typeof tool.dangerous === "function"
        ? (tool.dangerous as (args: unknown) => boolean)(parsed.data)
        : (tool.dangerous ?? false);

    // The gate sees the tab URL resolved for this call; step 19 adds policy on top.
    const tabUrl = access === "mutate"
        ? await resolveTabUrl(tool, parsed.data, runtime).catch(() => undefined)
        : undefined;
    const tab = access === "mutate" ? selectedTab(parsed.data, runtime) : undefined;
    const frame = tab === undefined
        ? undefined
        : await safetyFrameOf(parsed.data, tab, runtime.elements, runtime.frames).catch(
            () => undefined,
        );
    const decision = checkSafety({
        tool  : tool.name,
        access,
        config: runtime.config,
        target: tool.target?.(parsed.data as never),
        tabUrl,
        ...(frame === undefined ? {} : { frame }),
        dangerous,
    });

    if (!decision.allowed) return errorResult(`${decision.reason} ${decision.hint}`);

    const generation = runtime.access.sessionGeneration;

    try {
        const output = await raceWithSignal(
            tool.handler(parsed.data, runtime.context(extra.signal)),
            extra.signal,
        );
        const validated = tool.output.safeParse(output);

        if (!validated.success) {
            return errorResult(`The tool ${tool.name} returned an invalid result. Try the call again.`);
        }

        const value = validated.data as Record<string, unknown>;

        if (tool.present) return tool.present(validated.data);

        return jsonResult(value);
    } catch (error) {
        if (error instanceof SessionResetError) return errorResult(error.message);

        if (runtime.access.sessionGeneration !== generation) {
            return errorResult(new SessionResetError().message);
        }

        if (extra.signal.aborted) return errorResult(CANCELLED_MESSAGE);

        return errorResult(toToolMessage(error));
    }
}
