import { z } from "zod";
import { defineTool } from "./define-tool.js";
import { ToolError } from "./errors.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const BRING_TO_FRONT_TIMEOUT_MS = 5000;

export const bringToFront = defineTool({
    name       : "bring_to_front",
    closedWorld: true,
    description:
        "Bring a tab and its window to the front and take the keyboard focus. Call it only when the user asked to see the tab. It works only when the owner enabled allowFocus.",
    access : "mutate",
    input  : z.strictObject({ tab: tabSchema }),
    output : z.strictObject({ tab: z.string().describe("Id of the tab that was brought to the front.") }),
    handler: async (args, context) => {
        if (!context.config.allowFocus) {
            throw new ToolError(
                "Bringing a tab to the front is turned off. Ask the owner to enable allowFocus in the config, then call the tool again.",
            );
        }

        const targetId = resolveTab(args, context);

        await context.access.send({
            targetId,
            method   : "Page.bringToFront",
            timeoutMs: BRING_TO_FRONT_TIMEOUT_MS,
        });

        return { tab: targetId };
    },
});
