import { z } from "zod";
import { webOrigin } from "../safety/index.js";
import { defineTool } from "./define-tool.js";
import { ToolError } from "./errors.js";

const names = ["geolocation", "notifications", "camera", "microphone", "clipboard-read", "clipboard-write"] as const;

export const permissions = defineTool({
    name        : "permissions",
    description : "Grant, deny or reset a browser permission for a specific origin in this session's browser context.",
    access      : "mutate",
    tabUrlExempt: true,
    dangerous   : true,
    summarize   : (args: { name: string; origin: string; setting: string }) =>
        `It sets ${args.name} to ${args.setting} for ${args.origin}, including other tabs of that origin in a shared context.`,
    input: z.strictObject({
        name   : z.enum(names).describe("Permission to control."),
        setting: z.enum(["granted", "denied", "reset"]).describe("Override or release this session's override."),
        origin : z.string().min(1).max(2048)
            .refine((value) => webOrigin(value) !== undefined, { error: "Expected an http or https origin without a path." })
            .describe("Exact http or https origin without a path."),
    }),
    output: z.strictObject({
        name   : z.enum(names),
        setting: z.enum(["granted", "denied", "reset"]),
        origin : z.string(),
    }),
    target : (args) => ({ url: args.origin }),
    handler: async (args, context) => {
        const origin = webOrigin(args.origin);

        if (origin === undefined) throw new ToolError("origin must be an http or https origin without a path, such as https://example.com.");

        context.signal.throwIfAborted();
        await context.access.setPermission({ name: args.name, setting: args.setting, origin, owner: "permissions" });

        return { name: args.name, setting: args.setting, origin };
    },
});
