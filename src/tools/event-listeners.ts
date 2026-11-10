import { z } from "zod";
import { defineTool } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { assertElementOriginAllowed, elementAccess, elementTargetSchema, withElement } from "./element-target.js";
import { ToolError } from "./errors.js";
import { releaseQuietly } from "./remote-objects.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const listenerSchema = z.object({
    type      : z.string(),
    useCapture: z.boolean(),
    passive   : z.boolean(),
    once      : z.boolean(),
});

const handlerSchema = z.object({ objectId: z.string().optional() });
const rawListenersSchema = z.object({
    listeners: z.array(z.object({
        handler        : handlerSchema.optional(),
        originalHandler: handlerSchema.optional(),
    }).loose()),
}).loose();

function handlerObjectIds(raw: unknown): string[] {
    const parsed = rawListenersSchema.safeParse(raw);

    if (!parsed.success) return [];

    return parsed.data.listeners.flatMap((listener) =>
        [listener.handler?.objectId, listener.originalHandler?.objectId]
            .filter((id): id is string => id !== undefined),
    );
}

export const eventListeners = defineTool({
    name       : "event_listeners",
    description: "Inspect the event listener types and options registered directly on an element.",
    access     : "read",
    input      : z.strictObject({
        tab   : tabSchema,
        target: elementTargetSchema.describe("Element uid, CSS selector or locator."),
        limit : z.number().int().min(1).max(500).optional().describe("Maximum listeners to return. Defaults to 100."),
    }),
    output: z.strictObject({
        listeners: z.array(listenerSchema).describe("Listener types and options in browser order. Types are clipped to 200 characters."),
        total    : z.number().describe("Number of listeners before the limit."),
        truncated: z.boolean().describe("Whether listeners or event types were clipped."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        await ensureNoDialog(context.dialogs, targetId);

        return withElement(context, targetId, args.target, async (element) => {
            if (element.frameId === undefined && args.target.pierce !== true) {
                await assertElementOriginAllowed(context, targetId, element);
            }

            const access = elementAccess(context.access, element);
            const raw = await access.send({
                targetId,
                method: "DOMDebugger.getEventListeners",
                params: { objectId: element.objectId, depth: 1, pierce: false },
            });

            await releaseQuietly(access, targetId, handlerObjectIds(raw));

            const reply = z.object({ listeners: z.array(listenerSchema) }).safeParse(raw);

            if (!reply.success) throw new ToolError("The browser sent an unexpected response to DOMDebugger.getEventListeners. Try the call again.");

            const limit = args.limit ?? 100;
            const listeners = reply.data.listeners.slice(0, limit).map((listener) => ({
                ...listener,
                type: listener.type.slice(0, 200),
            }));

            return {
                listeners,
                total    : reply.data.listeners.length,
                truncated: reply.data.listeners.length > limit || listeners.some(
                    (listener, index) => listener.type.length <
                        (reply.data.listeners[index]?.type.length ?? 0),
                ),
            };
        });
    },
});
