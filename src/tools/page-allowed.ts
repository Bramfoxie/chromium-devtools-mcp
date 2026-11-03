import type { Config } from "../config/index.js";
import { describeUrlHost, isRestricted, isUrlAllowed } from "../safety/index.js";
import { ToolError } from "./errors.js";

export function assertPageAllowed(
    context: { config: Config },
    href   : string,
    subject = "The page shows",
): void {
    const domains = context.config.safety.allowedDomains;

    if (!isRestricted(domains) || href === "about:srcdoc" || isUrlAllowed(href, domains)) return;

    throw new ToolError(
        `${subject} ${describeUrlHost(href)}, which is outside safety.allowedDomains. Use an allowed domain, or ask the owner to add it to safety.allowedDomains.`,
    );
}
