import { describeBlock, describeUrlHost, isPolicyActive, navigationBlock } from "../safety/index.js";
import type { ToolContext } from "./define-tool.js";
import { ToolError } from "./errors.js";
import { resolutionProblem } from "./resolution-check.js";

const PARK_TIMEOUT_MS = 5000;

export class DomainRefusal extends ToolError {}

async function committedUrl(context: ToolContext, targetId: string, reported: string) {
    if (reported !== "") return reported;

    const tabs = await context.access.listTabs("owned").catch(() => []);

    return tabs.find((tab) => tab.targetId === targetId)?.url ?? "";
}

// Returns a message when the tab ended where the safety rules do not allow; it is then parked on about:blank.
export async function parkIfForbidden(
    context : ToolContext,
    targetId: string,
    reported: string,
): Promise<string | undefined> {
    const url = await committedUrl(context, targetId, reported);
    const { safety } = context.config;
    const unknown = isPolicyActive(safety) ? "outside-allowed" : undefined;
    const block = url === "" ? unknown : navigationBlock(url, safety);
    const described = block === undefined
        ? url === "" ? undefined : await resolutionProblem(url, safety, context.resolveHost)
        : describeBlock(block);

    if (described === undefined) return undefined;

    const host = url === "" ? "an unknown page" : describeUrlHost(url);
    const parked = await context.access
        .send({
            targetId,
            method   : "Page.navigate",
            params   : { url: "about:blank" },
            timeoutMs: PARK_TIMEOUT_MS,
        })
        .then(() => true, () => false);
    const state = parked
        ? "The tab was moved to about:blank."
        : "The tab could not be moved away and still shows that page; close it with close_tab.";

    return `The navigation ended on ${host}, ${described.reason}. ${state} ${described.hint}`;
}

export async function requireAllowedFinalUrl(
    context : ToolContext,
    targetId: string,
    reported: string,
): Promise<void> {
    const message = await parkIfForbidden(context, targetId, reported);

    if (message !== undefined) throw new DomainRefusal(message);
}
