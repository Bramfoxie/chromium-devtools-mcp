import { z } from "zod";
import { defineTool } from "../define-tool.js";
import { ensureNoDialog } from "../dialogs.js";
import { ToolError } from "../errors.js";
import { throwIfCancelled } from "../registry.js";
import {
    buildLocaleCommands,
    buildLocaleResetCommands,
    buildUserAgentCommand,
    canonicalLocale,
    checkedTimezone,
    type LocaleSelection,
} from "./commands.js";
import { readLocale } from "./reads.js";
import { runSteps } from "./steps.js";
import { emulationSummarySchema, summarizeEmulation } from "./summary.js";

export const ACCEPT_LANGUAGE_MAX_CHARS = 512;

const acceptLanguagePattern = /^[\x20-\x7E]*$/;

export function checkAcceptLanguage(value: string): void {
    if (!acceptLanguagePattern.test(value)) {
        throw new ToolError(
            "The accept language must use printable ASCII characters only, for example de-DE,de;q=0.9.",
        );
    }
}

export function checkLocaleSelection(
    selection: Partial<LocaleSelection> & { reset: boolean },
): void {
    if (selection.reset && hasLocaleSelection({ ...selection, reset: false })) {
        throw new ToolError("reset: true takes no other locale fields.");
    }
}

export function hasLocaleSelection(
    selection: Partial<LocaleSelection> & { reset: boolean },
): boolean {
    return selection.reset ||
        selection.locale !== undefined || selection.timezone !== undefined ||
        selection.acceptLanguage !== undefined;
}

const reportedSchema = z.strictObject({
    language : z.string().describe("navigator.language the page reports."),
    timezone : z.string().optional().describe("Timezone the page reports, when known."),
    formatted: z.string().describe("A fixed date formatted with the page locale and timezone."),
});

export const emulateLocale = defineTool({
    name       : "emulate_locale",
    closedWorld: true,
    description:
        "Emulate locale, timezone and Accept-Language on a tab. Applies to new page loads: navigator.language changes after the next navigation, and number and date formatting follow the locale. Geolocation is not emulated. reset restores the real locale and timezone.",
    access: "mutate",
    input : z.strictObject({
        tab           : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        locale        : z.string().min(1).max(64).optional().describe("BCP 47 tag such as de-DE. Merges with the previous timezone and accept language."),
        timezone      : z.string().min(1).max(64).optional().describe("IANA name such as Europe/Berlin."),
        acceptLanguage: z.string().min(1).max(ACCEPT_LANGUAGE_MAX_CHARS).optional().describe("Accept-Language header value, printable ASCII. Merges with the device user agent."),
        reset         : z.boolean().optional().describe("Remove the locale overrides of this tab. Defaults to false."),
    }),
    output: z.strictObject({
        tab      : z.string().describe("Tab id."),
        emulation: emulationSummarySchema.describe("Emulation state of the tab after the call."),
        reported : reportedSchema.optional().describe("Language and timezone the page reports, when it answers."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        const selection: LocaleSelection & { reset: boolean } = {
            locale        : args.locale,
            timezone      : args.timezone,
            acceptLanguage: args.acceptLanguage,
            reset         : args.reset ?? false,
        };

        if (!hasLocaleSelection(selection)) {
            throw new ToolError(
                "Provide locale, timezone, acceptLanguage, or reset: true. Nothing was changed.",
            );
        }

        checkLocaleSelection(selection);

        if (selection.acceptLanguage !== undefined) checkAcceptLanguage(selection.acceptLanguage);

        const locale = selection.locale === undefined
            ? undefined
            : canonicalLocale(selection.locale);
        const timezone = selection.timezone === undefined
            ? undefined
            : checkedTimezone(selection.timezone);

        throwIfCancelled(context.signal);

        await ensureNoDialog(context.dialogs, targetId);

        const reportedOf = async () => {
            const reported = await readLocale(context.access, targetId, context.signal);

            return reported === undefined ? {} : {
                reported: {
                    language : reported.language,
                    ...(reported.timezone === undefined ? {} : { timezone: reported.timezone }),
                    formatted: reported.formatted,
                },
            };
        };

        if (selection.reset) {
            const userAgent = context.emulation.snapshot(targetId).device?.userAgent;
            const agent = buildUserAgentCommand({ userAgent, acceptLanguage: undefined });

            await runSteps(context.access, context.signal, targetId, [
                {
                    commands: [...buildLocaleResetCommands(), ...(agent ? [agent] : [])],
                    record  : () => context.emulation.resetLocale(targetId),
                },
            ]);

            return {
                tab      : targetId,
                emulation: summarizeEmulation(context.emulation.snapshot(targetId)),
                ...await reportedOf(),
            };
        }

        const previous = context.emulation.snapshot(targetId).locale;
        const merged: LocaleSelection = {
            locale        : locale ?? previous?.locale,
            timezone      : timezone ?? previous?.timezone,
            acceptLanguage: selection.acceptLanguage ?? previous?.acceptLanguage,
        };
        const userAgent = context.emulation.snapshot(targetId).device?.userAgent;
        const agent = selection.acceptLanguage !== undefined || userAgent !== undefined
            ? buildUserAgentCommand({ userAgent, acceptLanguage: merged.acceptLanguage })
            : undefined;
        const previousAgent = buildUserAgentCommand({
            userAgent,
            acceptLanguage: previous?.acceptLanguage,
        });
        const restore = () => {
            if (previous === undefined) context.emulation.resetLocale(targetId);
            else context.emulation.applyLocale(targetId, previous);
        };

        await runSteps(context.access, context.signal, targetId, [
            {
                commands: [...buildLocaleCommands({ locale, timezone, acceptLanguage: undefined })],
                record  : () => context.emulation.applyLocale(targetId, {
                    locale        : merged.locale,
                    timezone      : merged.timezone,
                    acceptLanguage: previous?.acceptLanguage,
                }),
                undo: [
                    ...buildLocaleResetCommands(),
                    ...buildLocaleCommands({
                        locale        : previous?.locale,
                        timezone      : previous?.timezone,
                        acceptLanguage: undefined,
                    }),
                ],
                unrecord: restore,
            },
            {
                commands: agent ? [agent] : [],
                record  : () => context.emulation.applyLocale(targetId, merged),
                undo    : previousAgent ? [previousAgent] : [],
                unrecord: restore,
            },
        ]);

        return {
            tab      : targetId,
            emulation: summarizeEmulation(context.emulation.snapshot(targetId)),
            ...await reportedOf(),
        };
    },
});
