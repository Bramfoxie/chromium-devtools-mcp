import { confirmationRefusal } from "./confirmation.js";
import type { ToolRuntime } from "./context.js";
import type { AnyTool } from "./define-tool.js";
import { describeUrlHost, isPolicyActive } from "../safety/index.js";
import { checkSafety, type SafetyAccess, type SafetyDecision, type SafetyFrame } from "./safety.js";
import { resolutionProblem } from "../safety/resolution-check.js";
import { safetyFramesOf } from "./safety-frame.js";
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

    if (access === "mutate" && isPolicyActive(runtime.config.safety) && !exempt) {
        try {
            tabUrl = await resolveTabUrl(args, runtime);
        } catch {
            return {
                admitted: false,
                message : "The tab URL could not be read to check it against the domain rules in safety. Call the tool again.",
            };
        }
    }

    const tab = access === "mutate" ? selectedTab(args, runtime) : undefined;
    let frames: SafetyFrame[] = [];

    if (tab !== undefined) {
        try {
            frames = await safetyFramesOf(args, tab, runtime.elements, runtime.frames);
        } catch {
            if (isPolicyActive(runtime.config.safety)) {
                return {
                    admitted: false,
                    message : "The frame of the target could not be checked against the domain rules in safety. Call the tool again.",
                };
            }
        }
    }

    const base = {
        tool  : tool.name,
        access,
        config: runtime.config,
        target: tool.target?.(args),
        tabUrl,
        dangerous,
    };
    let decision = checkSafety(base);

    for (const frame of frames) {
        if (!decision.allowed) break;

        decision = checkSafety({ ...base, frame });
    }

    if (!decision.allowed) return refusal(decision);

    const opening = base.target?.url;
    const permissionReset = tool.name === "permissions" &&
        (args as { setting?: unknown } | null)?.setting === "reset";
    const problem = opening === undefined || access !== "mutate" || permissionReset
        ? undefined
        : await resolutionProblem(opening, runtime.config.safety, runtime.resolveHost);

    if (problem !== undefined) {
        return {
            admitted: false,
            message : `${tool.name} would open ${describeUrlHost(opening ?? "")}, ${problem.reason}. ${problem.hint}`,
        };
    }

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
