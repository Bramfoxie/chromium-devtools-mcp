import { z } from "zod";
import { a11yEntries } from "./a11y-tree.js";
import { toAxNodes } from "./ax-format.js";
import { defineTool } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { elementAccess, elementTargetSchema, withElement } from "./element-target.js";
import { ToolError } from "./errors.js";
import { elementLocatorSchema } from "./locator-schema.js";
import { pickLocator } from "./locator-suggest.js";
import { resolveTab, tabSchema } from "./tab-target.js";
import { SELECTOR_EXPRESSION } from "./selector-script.js";

const scriptResultSchema = z.object({
    result: z.object({
        value: z.object({
            selector: z.string(),
            unique  : z.boolean(),
            frame   : z.string().optional(),
        }).optional(),
    }),
    exceptionDetails: z.unknown().optional(),
});

const SELECTOR_MAX_CHARS = 1000;

export const domSelector = defineTool({
    name: "dom_selector",
    description:
        "Turn an element into a CSS selector and a role locator that find it again, checked to match only that element.",
    access: "read",
    input : z.strictObject({
        tab   : tabSchema,
        target: elementTargetSchema.describe("Element uid from a snapshot or query, or any other target."),
    }),
    output: z.strictObject({
        selector: z.string().describe("A CSS selector for the element, with ' >>> ' between a shadow host and a selector inside its shadow root."),
        unique  : z.boolean().describe("Whether the selector matches this element and no other in its document."),
        frame   : z.string().optional().describe("For an element in an iframe: the selector of the iframe in its parent document, for the frame argument of element targets."),
        locator : elementLocatorSchema.optional().describe("A locator by accessibility role and name that finds this element again, with exact and nth when the name alone is not enough. Absent when the element has no accessible name."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        await ensureNoDialog(context.dialogs, targetId);

        return withElement(context, targetId, args.target, async (element) => {
            const owner = elementAccess(context.access, element);
            const parsed = scriptResultSchema.safeParse(
                await owner.send({
                    targetId,
                    method: "Runtime.callFunctionOn",
                    params: {
                        functionDeclaration: SELECTOR_EXPRESSION,
                        objectId           : element.objectId,
                        arguments          : [{ objectId: element.objectId }],
                        returnByValue      : true,
                    },
                }),
            );
            const value = parsed.success ? parsed.data.result.value : undefined;

            const failed = !parsed.success
                || value === undefined
                || parsed.data.exceptionDetails !== undefined;

            if (failed || value === undefined) {
                throw new ToolError(
                    "The selector of the element could not be built. Take a new snapshot and try again.",
                );
            }

            const tree = await owner.send({
                targetId,
                method: "Accessibility.getFullAXTree",
                params: element.frameId !== undefined && element.isolated !== true
                    ? { frameId: element.frameId }
                    : {},
            }).catch(() => undefined);
            const entries = tree === undefined
                ? []
                : a11yEntries(toAxNodes(tree), {
                    interactiveOnly : false,
                    includeHidden   : false,
                    startBackendNode: undefined,
                });
            const locator = pickLocator(entries, element.backendNodeId);

            return {
                selector: value.selector.slice(0, SELECTOR_MAX_CHARS),
                unique  : value.unique,
                ...(value.frame === undefined
                    ? {}
                    : { frame: value.frame.slice(0, SELECTOR_MAX_CHARS) }),
                ...(locator === undefined ? {} : { locator }),
            };
        });
    },
});
