import { confirmationRefusal } from "./confirmation.js";
import type { ToolRuntime } from "./context.js";
import type { AnyTool } from "./define-tool.js";
import { isRestricted } from "../safety/index.js";
import { checkSafety, type SafetyAccess, type SafetyDecision, type SafetyFrame } from "./safety.js";
import { safetyFrameOf } from "./safety-frame.js";
import { accessFor, dangerousFor, tabUrlExemptFor } from "./tool-traits.js";

type Admission =
    | { admitted: true; confirmed: boolean }
    | { admitted: false; message: string };

function explicitTab(args: unknown): string | undefined {
    const argTab = (args as { tab?: unknown } | null)?.tab;

    return typeof argTab === "string" && argTab.length > 0 ? argTab : undefined;
}

function selectedTab(args: unknown, runtime: ToolRuntime): string | undefined {
    return explicitTab(args) ?? runtime.tabs.selected();
}

async function resolveTabUrl(
    args   : unknown,
    runtime: ToolRuntime,
): Promise<string | undefined> {
    const tab = selectedTab(args, runtime);

    if (tab === undefined) return undefined;

    const tabs = await runtime.access.listTabs("owned");

    return tabs.find((known) => known.targetId === tab)?.url;
}

function refusal(decision: Extract<SafetyDecision, { allowed: false }>): Admission {
    return { admitted: false, message: `${decision.reason} ${decision.hint}` };
}

// Read-only calls without a confirmation are decided synchronously so they start at once.
export function admit(
    tool   : AnyTool,
    args   : unknown,
    signal : AbortSignal,
    runtime: ToolRuntime,
): Admission | Promise<Admission> {
    const access = accessFor(tool, args);
    const dangerous = dangerousFor(tool, args);

    if (access === "mutate" || (dangerous && runtime.config.safety.confirmDangerous)) {
        return admitWithChecks(tool, args, signal, runtime, access, dangerous);
    }

    const decision = checkSafety({ tool: tool.name, access, config: runtime.config, dangerous });

    return decision.allowed ? { admitted: true, confirmed: false } : refusal(decision);
}

async function admitWithChecks(
    tool     : AnyTool,
    args     : unknown,
    signal   : AbortSignal,
    runtime  : ToolRuntime,
    access   : SafetyAccess,
    dangerous: boolean,
): Promise<Admission> {
    const exempt = tabUrlExemptFor(tool, args);
    let tabUrl: string | undefined;

    if (access === "mutate" && isRestricted(runtime.config.safety.allowedDomains) && !exempt) {
        try {
            tabUrl = await resolveTabUrl(args, runtime);
        } catch {
            return {
                admitted: false,
                message : "The tab URL could not be read to check it against safety.allowedDomains. Call the tool again.",
            };
        }
    }

    const tab = access === "mutate" ? selectedTab(args, runtime) : undefined;
    let frame: SafetyFrame | undefined;

    if (tab !== undefined) {
        try {
            frame = await safetyFrameOf(args, tab, runtime.elements, runtime.frames);
        } catch {
            if (isRestricted(runtime.config.safety.allowedDomains)) {
                return {
                    admitted: false,
                    message : "The frame of the target could not be checked against safety.allowedDomains. Call the tool again.",
                };
            }
        }
    }

    const decision = checkSafety({
        tool  : tool.name,
        access,
        config: runtime.config,
        target: tool.target?.(args),
        tabUrl,
        ...(frame === undefined ? {} : { frame }),
        dangerous,
    });

    if (!decision.allowed) return refusal(decision);

    if (!dangerous || !runtime.config.safety.confirmDangerous) {
        return { admitted: true, confirmed: false };
    }

    const outcome = runtime.confirm === undefined
        ? "unsupported" as const
        : await runtime.confirm(
            {
                tool   : tool.name,
                summary: tool.summarize?.(args) ?? "It can reach beyond the page.",
            },
            signal,
        );

    return outcome === "accepted"
        ? { admitted: true, confirmed: true }
        : { admitted: false, message: confirmationRefusal(tool.name, outcome) };
}
