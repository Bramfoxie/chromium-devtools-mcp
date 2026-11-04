import type { Config } from "../config/index.js";
import { describeBlock, describeUrlHost, domainBlock } from "../safety/index.js";
import { ToolError } from "./errors.js";

export function assertPageAllowed(
    context: { config: Config },
    href   : string,
    subject = "The page shows",
): void {
    const block = domainBlock(href, context.config.safety);

    if (block === undefined) return;

    const described = describeBlock(block);

    throw new ToolError(`${subject} ${describeUrlHost(href)}, ${described.reason}. ${described.hint}`);
}
