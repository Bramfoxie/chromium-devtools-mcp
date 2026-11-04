import { describeUrlHost, isRestricted, isUrlAllowed } from "../safety/index.js";
import type { ToolContext } from "./define-tool.js";
import { ToolError } from "./errors.js";

const PARK_TIMEOUT_MS = 5000;

export class DomainRefusal extends ToolError {}

async function committedUrl(context: ToolContext, targetId: string, reported: string) {
    if (reported !== "") return reported;

    const tabs = await context.access.listTabs("owned").catch(() => []);

    return tabs.find((tab) => tab.targetId === targetId)?.url ?? "";
}

// Returns a message when the tab ended outside the allowlist; the tab is then parked on about:blank.
export async function parkIfForbidden(
    context : ToolContext,
    targetId: string,
    reported: string,
): Promise<string | undefined> {
    const domains = context.config.safety.allowedDomains;

    if (!isRestricted(domains)) return undefined;

    const url = await committedUrl(context, targetId, reported);

    if (url !== "" && isUrlAllowed(url, domains)) return undefined;

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

    return `The navigation ended on ${host}, which is outside safety.allowedDomains. ${state} Navigate to an allowed domain, or ask the owner to add it to safety.allowedDomains.`;
}

export async function requireAllowedFinalUrl(
    context : ToolContext,
    targetId: string,
    reported: string,
): Promise<void> {
    const message = await parkIfForbidden(context, targetId, reported);

    if (message !== undefined) throw new DomainRefusal(message);
}
