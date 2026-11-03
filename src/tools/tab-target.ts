import { z } from "zod";
import type { ToolContext } from "./define-tool.js";
import { ToolError } from "./errors.js";

export const tabSchema = z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Tab id. Defaults to the selected tab.");

export function noTabError(): ToolError {
    return new ToolError("No tab is selected. Open one with new_tab first.");
}

export function resolveTab(
    args   : { tab?: string | undefined },
    context: Pick<ToolContext, "state">,
): string {
    const targetId = args.tab ?? context.state.selected;

    if (targetId === undefined) throw noTabError();

    return targetId;
}
