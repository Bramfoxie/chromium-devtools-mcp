import { z } from "zod";
import { defineTool } from "../define-tool.js";
import { ensureNoDialog } from "../dialogs.js";
import { ToolError } from "../errors.js";
import { throwIfCancelled } from "../registry.js";
import {
    BLOCK_URL_MAX_CHARS,
    BLOCK_URLS_MAX,
    buildBlockedUrlsCommands,
    buildNetworkCommands,
    buildNetworkResetCommands,
    NETWORK_LATENCY_MAX_MS,
    NETWORK_THROUGHPUT_MAX_KBPS,
    presetConditions,
    type NetworkConditions,
    type NetworkPresetName,
} from "./commands.js";
import { runSteps } from "./steps.js";
import { emulationSummarySchema, summarizeEmulation } from "./summary.js";
import { resolveTab, tabSchema } from "../tab-target.js";

const presetSchema = z.enum(["offline", "slow-3g", "fast-3g", "4g", "wifi", "none"]);

interface NetworkInput {
    preset      : NetworkPresetName | undefined;
    latencyMs   : number | undefined;
    downloadKbps: number | undefined;
    uploadKbps  : number | undefined;
    offline     : boolean | undefined;
    blockUrls   : string[] | undefined;
    reset       : boolean;
}

export function checkNetworkInput(input: NetworkInput): void {
    const hasPreset = input.preset !== undefined;
    const hasCustom = input.latencyMs !== undefined || input.downloadKbps !== undefined ||
        input.uploadKbps !== undefined || input.offline !== undefined;

    if (input.reset && (hasPreset || hasCustom || input.blockUrls !== undefined)) {
        throw new ToolError("reset: true takes no other network fields.");
    }

    if (input.downloadKbps === 0 || input.uploadKbps === 0) {
        throw new ToolError(
            "A throughput of 0 stalls the link. Use a positive Kbps value, -1 to remove the limit, or offline: true.",
        );
    }

    if (hasPreset && hasCustom) {
        throw new ToolError("Provide either preset or the custom latency and throughput fields, not both.");
    }

    if (!input.reset && !hasPreset && !hasCustom && input.blockUrls === undefined) {
        throw new ToolError(
            "Provide a preset, the custom network fields, blockUrls, or reset: true. Nothing was changed.",
        );
    }
}

export function conditionsOf(
    input   : NetworkInput,
    previous: NetworkConditions | undefined,
): NetworkConditions {
    if (input.preset !== undefined) return presetConditions(input.preset);

    return {
        offline     : input.offline ?? previous?.offline ?? false,
        latencyMs   : input.latencyMs ?? previous?.latencyMs ?? 0,
        downloadKbps: input.downloadKbps ?? previous?.downloadKbps ?? -1,
        uploadKbps  : input.uploadKbps ?? previous?.uploadKbps ?? -1,
    };
}

async function ensureNetworkForEmulation(
    ensure  : (tab: string) => Promise<void>,
    targetId: string,
): Promise<void> {
    await ensure(targetId);
}

export const emulateNetwork = defineTool({
    name       : "emulate_network",
    untrusted  : false,
    closedWorld: true,
    description:
        "Emulate network conditions on a tab: offline, slow-3g (2000 ms, 400/400 Kbps), fast-3g (562 ms, 1600/750 Kbps), 4g (170 ms, 9000/9000 Kbps), wifi (28 ms, 30000/15000 Kbps) or none. Shares Network.enable with the capture manager, never disables capture.",
    access: "mutate",
    input : z.strictObject({
        tab         : tabSchema,
        preset      : presetSchema.optional().describe("Named conditions. none restores a normal connection and clears blocked URLs."),
        latencyMs   : z.number().int().min(0).max(NETWORK_LATENCY_MAX_MS).optional().describe("Added latency in ms, 0 to 60000."),
        downloadKbps: z.number().int().min(-1).max(NETWORK_THROUGHPUT_MAX_KBPS).optional().describe("Download ceiling in Kbps, at least 1, -1 disables throttling. 0 is rejected because it stalls the link."),
        uploadKbps  : z.number().int().min(-1).max(NETWORK_THROUGHPUT_MAX_KBPS).optional().describe("Upload ceiling in Kbps, at least 1, -1 disables throttling. 0 is rejected because it stalls the link."),
        offline     : z.boolean().optional().describe("Emulate disconnection. Defaults to false."),
        blockUrls   : z.array(z.string().min(1).max(BLOCK_URL_MAX_CHARS)).max(BLOCK_URLS_MAX).optional().describe("URL patterns to block with CDP wildcards, at most 50."),
        reset       : z.boolean().optional().describe("Restore a normal connection and clear blocked URLs. Defaults to false."),
    }),
    output: z.strictObject({
        tab      : z.string().describe("Tab id."),
        emulation: emulationSummarySchema.describe("Emulation state of the tab after the call."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        const input: NetworkInput = {
            preset      : args.preset,
            latencyMs   : args.latencyMs,
            downloadKbps: args.downloadKbps,
            uploadKbps  : args.uploadKbps,
            offline     : args.offline,
            blockUrls   : args.blockUrls,
            reset       : args.reset ?? false,
        };

        checkNetworkInput(input);
        throwIfCancelled(context.signal);

        await ensureNoDialog(context.dialogs, targetId);

        if (input.reset) {
            const [conditionsReset, blocksReset] = buildNetworkResetCommands();

            await runSteps(context.access, context.signal, targetId, [
                {
                    commands: conditionsReset ? [conditionsReset] : [],
                    record  : () => {
                        const current = context.emulation.snapshot(targetId).network;

                        if (current !== undefined) {
                            context.emulation.applyNetwork(targetId, {
                                ...presetConditions("none"),
                                preset   : undefined,
                                blockUrls: current.blockUrls,
                            });
                        }
                    },
                },
                { commands: blocksReset ? [blocksReset] : [], record: () => undefined },
            ]);

            const state = context.emulation.resetNetwork(targetId);

            return { tab: targetId, emulation: summarizeEmulation(state) };
        }

        await ensureNetworkForEmulation((tab) => context.capture.ensureNetwork(tab), targetId);

        const previous = context.emulation.snapshot(targetId).network;
        const conditions = conditionsOf(input, previous);
        const blockUrls = input.blockUrls ??
            (input.preset === "none" ? [] : previous?.blockUrls ?? []);
        const preset = input.preset ??
            (input.blockUrls !== undefined ? previous?.preset : undefined);
        const restore = () => {
            if (previous === undefined) context.emulation.resetNetwork(targetId);
            else context.emulation.applyNetwork(targetId, previous);
        };

        await runSteps(context.access, context.signal, targetId, [
            {
                commands: buildNetworkCommands(conditions),
                record  : () => context.emulation.applyNetwork(targetId, {
                    ...conditions,
                    preset,
                    blockUrls: previous?.blockUrls ?? [],
                }),
                undo: buildNetworkCommands(
                    previous === undefined ? presetConditions("none") : previous,
                ),
                unrecord: restore,
            },
            {
                commands: buildBlockedUrlsCommands(blockUrls),
                record  : () => context.emulation.applyNetwork(targetId, {
                    ...conditions,
                    preset,
                    blockUrls,
                }),
                undo    : buildBlockedUrlsCommands(previous?.blockUrls ?? []),
                unrecord: restore,
            },
        ]);

        const state = context.emulation.snapshot(targetId);

        return { tab: targetId, emulation: summarizeEmulation(state) };
    },
});
