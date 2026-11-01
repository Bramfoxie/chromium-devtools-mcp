import { z } from "zod";
import type { DaemonAccess } from "../../mcp/index.js";
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
import { emulationSummarySchema, summarizeEmulation } from "./summary.js";

const presetSchema = z.enum(["offline", "slow-3g", "fast-3g", "4g", "wifi", "none"]);

export interface NetworkInput {
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

export async function ensureNetworkForEmulation(
    access  : DaemonAccess,
    ensure  : (tab: string) => Promise<void>,
    targetId: string,
): Promise<void> {
    // Shares the capture manager flag, so emulation never disables network capture.
    await ensure(targetId);
}

export const emulateNetwork = defineTool({
    name: "emulate_network",
    description:
        "Emulate network conditions on a tab: offline, slow-3g (2000 ms, 400/400 Kbps), fast-3g (562 ms, 1600/750 Kbps), 4g (170 ms, 9000/9000 Kbps), wifi (28 ms, 30000/15000 Kbps) or none. Shares Network.enable with the capture manager, never disables capture.",
    access: "mutate",
    input : z.strictObject({
        tab         : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        preset      : presetSchema.optional().describe("Named conditions. none restores a normal connection."),
        latencyMs   : z.number().int().min(0).max(NETWORK_LATENCY_MAX_MS).optional().describe("Added latency in ms, 0 to 60000."),
        downloadKbps: z.number().int().min(-1).max(NETWORK_THROUGHPUT_MAX_KBPS).optional().describe("Download ceiling in Kbps, -1 disables throttling."),
        uploadKbps  : z.number().int().min(-1).max(NETWORK_THROUGHPUT_MAX_KBPS).optional().describe("Upload ceiling in Kbps, -1 disables throttling."),
        offline     : z.boolean().optional().describe("Emulate disconnection. Defaults to false."),
        blockUrls   : z.array(z.string().min(1).max(BLOCK_URL_MAX_CHARS)).max(BLOCK_URLS_MAX).optional().describe("URL patterns to block with CDP wildcards, at most 50."),
        reset       : z.boolean().optional().describe("Restore a normal connection and clear blocked URLs. Defaults to false."),
    }),
    output: z.strictObject({
        tab      : z.string().describe("Tab id."),
        emulation: emulationSummarySchema.describe("Emulation state of the tab after the call."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

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
            for (const command of buildNetworkResetCommands()) {
                await context.access.send(targetId, command.method, command.params);
            }

            const state = context.emulation.resetNetwork(targetId);

            return { tab: targetId, emulation: summarizeEmulation(state) };
        }

        await ensureNetworkForEmulation(
            context.access,
            (tab) => context.capture.ensureNetwork(tab),
            targetId,
        );

        const previous = context.emulation.snapshot(targetId).network;
        const conditions = conditionsOf(input, previous);
        const blockUrls = input.blockUrls ?? previous?.blockUrls ?? [];

        for (const command of buildNetworkCommands(conditions)) {
            await context.access.send(targetId, command.method, command.params);
        }

        for (const command of buildBlockedUrlsCommands(blockUrls)) {
            await context.access.send(targetId, command.method, command.params);
        }

        const state = context.emulation.applyNetwork(targetId, {
            ...conditions,
            preset: input.preset ?? (input.blockUrls !== undefined ? previous?.preset : undefined),
            blockUrls,
        });

        return { tab: targetId, emulation: summarizeEmulation(state) };
    },
});
