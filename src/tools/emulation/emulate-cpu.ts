import { z } from "zod";
import { defineTool } from "../define-tool.js";
import { ensureNoDialog } from "../dialogs.js";
import { ToolError } from "../errors.js";
import { throwIfCancelled } from "../registry.js";
import { resolveTab, tabSchema } from "../tab-target.js";
import { buildCpuCommands, buildCpuResetCommands, CPU_SLOWDOWN_MAX } from "./commands.js";
import { runSteps } from "./steps.js";
import { emulationSummarySchema, summarizeEmulation } from "./summary.js";

export const emulateCpu = defineTool({
    name       : "emulate_cpu",
    untrusted  : false,
    closedWorld: true,
    description:
        "Request CPU throttling for a tab; the observed slowdown depends on the browser and workload.",
    access: "mutate",
    input : z.strictObject({
        tab     : tabSchema,
        slowdown: z.number().min(1).max(CPU_SLOWDOWN_MAX).optional()
            .describe(`Requested slowdown, from 1 to ${CPU_SLOWDOWN_MAX}. 1 removes the override.`),
        reset: z.boolean().optional().describe("Restore full speed. Defaults to false."),
    }),
    output: z.strictObject({
        tab      : z.string().describe("Tab id."),
        emulation: emulationSummarySchema.describe("Emulation state of the tab after the call."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);
        const reset = args.reset ?? false;

        if (reset && args.slowdown !== undefined) {
            throw new ToolError("reset: true takes no slowdown.");
        }

        if (!reset && args.slowdown === undefined) {
            throw new ToolError("Provide a slowdown or reset: true. Nothing was changed.");
        }

        throwIfCancelled(context.signal);
        await ensureNoDialog(context.dialogs, targetId);

        const slowdown = reset ? 1 : args.slowdown ?? 1;
        const previous = context.emulation.snapshot(targetId).cpu;

        await runSteps(context.access, context.signal, targetId, [
            {
                commands: slowdown === 1 ? buildCpuResetCommands() : buildCpuCommands({ slowdown }),
                record  : () => {
                    if (slowdown === 1) context.emulation.resetCpu(targetId);
                    else context.emulation.applyCpu(targetId, { slowdown });
                },
                undo: previous === undefined
                    ? buildCpuResetCommands()
                    : buildCpuCommands(previous),
                unrecord: () => {
                    if (previous === undefined) context.emulation.resetCpu(targetId);
                    else context.emulation.applyCpu(targetId, previous);
                },
            },
        ]);

        const state = context.emulation.snapshot(targetId);

        return { tab: targetId, emulation: summarizeEmulation(state) };
    },
});
