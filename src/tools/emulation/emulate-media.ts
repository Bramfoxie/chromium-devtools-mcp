import { z } from "zod";
import { defineTool } from "../define-tool.js";
import { ensureNoDialog } from "../dialogs.js";
import { ToolError } from "../errors.js";
import { throwIfCancelled } from "../registry.js";
import {
    buildMediaCommands,
    buildMediaResetCommands,
    mergeMedia,
    type MediaSelection,
    type MediaState,
} from "./commands.js";
import { readMedia } from "./reads.js";
import { runSteps } from "./steps.js";
import { emulationSummarySchema, summarizeEmulation } from "./summary.js";

export function checkMediaSelection(
    selection: Partial<MediaSelection> & { reset: boolean },
): void {
    if (selection.reset && hasMediaSelection({ ...selection, reset: false })) {
        throw new ToolError("reset: true takes no other media fields.");
    }
}

export function hasMediaSelection(
    selection: Partial<MediaSelection> & { reset: boolean },
): boolean {
    return selection.reset ||
        selection.media !== undefined || selection.colorScheme !== undefined ||
        selection.reducedMotion !== undefined || selection.contrast !== undefined ||
        selection.forcedColors !== undefined || selection.reducedData !== undefined;
}

const reportedSchema = z.strictObject({
    colorScheme  : z.string().describe("prefers-color-scheme the page reports."),
    reducedMotion: z.string().describe("prefers-reduced-motion the page reports."),
    contrast     : z.string().describe("prefers-contrast the page reports."),
    forcedColors : z.string().describe("forced-colors the page reports."),
    reducedData  : z.string().describe("prefers-reduced-data the page reports."),
    mediaPrint   : z.boolean().describe("Whether the page matches the print medium."),
});

export const emulateMedia = defineTool({
    name       : "emulate_media",
    description: "Emulate a media type and media features on a tab. Only the given fields change; reset removes every media override.",
    access     : "mutate",
    input      : z.strictObject({
        tab          : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        media        : z.enum(["screen", "print", ""]).optional().describe("Media type to emulate, empty clears the type."),
        colorScheme  : z.enum(["light", "dark", "no-preference"]).optional().describe("Emulated prefers-color-scheme."),
        reducedMotion: z.enum(["reduce", "no-preference"]).optional().describe("Emulated prefers-reduced-motion."),
        contrast     : z.enum(["more", "less", "no-preference"]).optional().describe("Emulated prefers-contrast."),
        forcedColors : z.enum(["active", "none"]).optional().describe("Emulated forced-colors."),
        reducedData  : z.enum(["reduce", "no-preference"]).optional().describe("Emulated prefers-reduced-data."),
        reset        : z.boolean().optional().describe("Remove the media overrides of this tab. Defaults to false."),
    }),
    output: z.strictObject({
        tab      : z.string().describe("Tab id."),
        emulation: emulationSummarySchema.describe("Emulation state of the tab after the call."),
        reported : reportedSchema.optional().describe("Media features the page reports, when it answers."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        const selection: MediaSelection & { reset: boolean } = {
            media        : args.media,
            colorScheme  : args.colorScheme,
            reducedMotion: args.reducedMotion,
            contrast     : args.contrast,
            forcedColors : args.forcedColors,
            reducedData  : args.reducedData,
            reset        : args.reset ?? false,
        };

        if (!hasMediaSelection(selection)) {
            throw new ToolError(
                "Provide at least one media field or reset: true. Nothing was changed.",
            );
        }

        checkMediaSelection(selection);
        throwIfCancelled(context.signal);

        await ensureNoDialog(context.dialogs, targetId);

        if (selection.reset) {
            await runSteps(context.access, context.signal, targetId, [
                {
                    commands: buildMediaResetCommands(),
                    record  : () => context.emulation.resetMedia(targetId),
                },
            ]);

            const reported = await readMedia(context.access, targetId, context.signal);

            return {
                tab      : targetId,
                emulation: summarizeEmulation(context.emulation.snapshot(targetId)),
                ...(reported === undefined ? {} : { reported: reported }),
            };
        }

        const previous = context.emulation.snapshot(targetId).media;
        const merged: MediaState = mergeMedia(previous, selection);

        await runSteps(context.access, context.signal, targetId, [
            {
                commands: buildMediaCommands(merged),
                record  : () => context.emulation.applyMedia(targetId, merged),
                undo    : previous === undefined
                    ? buildMediaResetCommands()
                    : buildMediaCommands(previous),
                unrecord: () => {
                    if (previous === undefined) context.emulation.resetMedia(targetId);
                    else context.emulation.applyMedia(targetId, previous);
                },
            },
        ]);

        const reported = await readMedia(context.access, targetId, context.signal);

        return {
            tab      : targetId,
            emulation: summarizeEmulation(context.emulation.snapshot(targetId)),
            ...(reported === undefined ? {} : { reported: reported }),
        };
    },
});
