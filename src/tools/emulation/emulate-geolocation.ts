import { z } from "zod";
import { defineTool, type ToolContext } from "../define-tool.js";
import { ensureNoDialog } from "../dialogs.js";
import { ToolError } from "../errors.js";
import { webOrigin } from "../../safety/index.js";
import { throwIfCancelled } from "../registry.js";
import { resolveTab, tabSchema } from "../tab-target.js";
import { buildGeolocationCommands, buildGeolocationResetCommands } from "./commands.js";
import { readGeolocation } from "./reads.js";
import { runSteps } from "./steps.js";
import { emulationSummarySchema, summarizeEmulation } from "./summary.js";

const ACCURACY_MAX_METERS = 100_000;

const ACCURACY_DEFAULT_METERS = 10;

const reportedSchema = z.strictObject({
    ok       : z.boolean().describe("Whether the page got a position."),
    latitude : z.number().optional().describe("Latitude the page reads."),
    longitude: z.number().optional().describe("Longitude the page reads."),
    accuracy : z.number().optional().describe("Accuracy in meters the page reads."),
    error    : z.string().optional().describe("Why the page got no position."),
});

function explicitOrigin(value: string): string {
    const origin = webOrigin(value);

    if (origin === undefined) {
        throw new ToolError(
            "origin must be an http or https origin without a path, such as https://example.com.",
        );
    }

    return origin;
}

async function tabOrigin(
    context : ToolContext,
    targetId: string,
): Promise<string> {
    const tabs = await context.access.listTabs("owned");
    const url = tabs.find((tab) => tab.targetId === targetId)?.url ?? "";

    try {
        const parsed = new URL(url);

        if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    } catch {
        // falls through to the explanation below
    }

    throw new ToolError(
        "The tab shows no web page yet, so there is no origin to allow. Pass origin, such as https://example.com, or navigate the tab first.",
    );
}

export const emulateGeolocation = defineTool({
    name       : "emulate_geolocation",
    untrusted  : false,
    closedWorld: true,
    description:
        "Emulate the geolocation of a tab and allow the page origin to read it, without a prompt. The page needs a secure context (https or localhost). Other tabs of the same origin in a shared browser read the real position while it is allowed. reset removes the override and the permission.",
    access   : "mutate",
    dangerous: (args: { reset?: boolean | undefined }) => args.reset !== true,
    summarize: (args: { origin?: string | undefined }) =>
        `It lets ${args.origin ?? "the page of the tab"} read a location without asking the user, and other tabs of that origin in a shared browser read the real location meanwhile.`,
    target: (args: { origin?: string | undefined }) =>
        args.origin === undefined ? undefined : { url: args.origin },
    input: z.strictObject({
        tab      : tabSchema,
        latitude : z.number().min(-90).max(90).optional().describe("Latitude in degrees, -90 to 90."),
        longitude: z.number().min(-180).max(180).optional().describe("Longitude in degrees, -180 to 180."),
        accuracy : z.number().min(0).max(ACCURACY_MAX_METERS).optional().describe(`Accuracy in meters. Defaults to ${ACCURACY_DEFAULT_METERS}.`),
        origin   : z.string().min(1).max(2048).optional().describe("Origin to allow, such as https://example.com. Defaults to the origin of the tab. Pass it to set the location before the first navigation."),
        reset    : z.boolean().optional().describe("Remove the geolocation override and permission of this tab. Defaults to false."),
    }),
    output: z.strictObject({
        tab      : z.string().describe("Tab id."),
        emulation: emulationSummarySchema.describe("Emulation state of the tab after the call."),
        reported : reportedSchema.optional().describe("Position the page reads now, when the tab shows the allowed origin."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);
        const reset = args.reset ?? false;
        const hasPosition = args.latitude !== undefined || args.longitude !== undefined;

        if (reset && (hasPosition || args.accuracy !== undefined || args.origin !== undefined)) {
            throw new ToolError("reset: true takes no other geolocation fields.");
        }

        if (!reset && (args.latitude === undefined || args.longitude === undefined)) {
            throw new ToolError("Provide latitude and longitude, or reset: true. Nothing was changed.");
        }

        return context.emulation.withGeolocation(async () => {
            throwIfCancelled(context.signal);

            try {
                await context.emulation.retryGeolocationCleanup(async (origin) => {
                    await context.access.setPermission({ name: "geolocation", setting: "reset", origin });
                });
            } catch {
                throw new ToolError("A previous geolocation permission could not be released. Retry or end the session, then check the browser permissions.");
            }

            throwIfCancelled(context.signal);
            await ensureNoDialog(context.dialogs, targetId);
            throwIfCancelled(context.signal);

            const previous = context.emulation.snapshot(targetId).geolocation;

            if (reset) {
                const release = previous !== undefined &&
                    !context.emulation.geolocationOrigins(targetId).has(previous.origin);

                if (release) {
                    await context.access.setPermission({
                        name   : "geolocation",
                        setting: "reset",
                        origin : previous.origin,
                    });
                }

                try {
                    await runSteps(context.access, context.signal, targetId, [
                        {
                            commands: buildGeolocationResetCommands(),
                            record  : () => context.emulation.resetGeolocation(targetId),
                            ...(previous === undefined
                                ? {}
                                : { undo: buildGeolocationCommands(previous) }),
                        },
                    ]);
                } catch (error) {
                    if (release) {
                        try {
                            await context.access.setPermission({
                                name: "geolocation", setting: "granted", origin: previous.origin,
                            });
                        } catch {
                            throw new ToolError("The geolocation reset failed and the previous permission could not be restored. Check the browser permissions and retry.");
                        }
                    }

                    throw error;
                }

                return {
                    tab      : targetId,
                    emulation: summarizeEmulation(context.emulation.snapshot(targetId)),
                };
            }

            await context.focus.ensure(context.access, targetId);

            const origin = args.origin === undefined
                ? await tabOrigin(context, targetId)
                : explicitOrigin(args.origin);
            const next = {
                latitude : args.latitude ?? 0,
                longitude: args.longitude ?? 0,
                accuracy : args.accuracy ?? ACCURACY_DEFAULT_METERS,
                origin,
            };

            const releasePrevious = previous !== undefined && previous.origin !== origin &&
                !context.emulation.geolocationOrigins(targetId).has(previous.origin);

            throwIfCancelled(context.signal);

            if (releasePrevious) {
                await context.access.setPermission({ name: "geolocation", setting: "reset", origin: previous.origin });
            }

            let granted = false;

            try {
                throwIfCancelled(context.signal);
                await context.access.setPermission({ name: "geolocation", setting: "granted", origin });
                granted = true;
                await runSteps(context.access, context.signal, targetId, [
                    {
                        commands: buildGeolocationCommands(next),
                        record  : () => context.emulation.applyGeolocation(targetId, next),
                        undo    : previous === undefined
                            ? buildGeolocationResetCommands()
                            : buildGeolocationCommands(previous),
                        unrecord: () => {
                            if (previous === undefined) {
                                context.emulation.resetGeolocation(targetId);
                            } else context.emulation.applyGeolocation(targetId, previous);
                        },
                    },
                ]);
            } catch (error) {
                const stillUsed = context.emulation.geolocationOrigins().has(origin);
                let cleanupFailed = false;

                if (granted && !stillUsed && previous?.origin !== origin) {
                    try {
                        await context.access.setPermission({ name: "geolocation", setting: "reset", origin });
                    } catch {
                        cleanupFailed = true;
                    }
                }

                if (releasePrevious) {
                    try {
                        await context.access.setPermission({ name: "geolocation", setting: "granted", origin: previous.origin });
                    } catch {
                        cleanupFailed = true;
                    }
                }

                if (cleanupFailed) {
                    throw new ToolError("The geolocation change failed and permission cleanup was incomplete. End this session to release its permissions, then check the browser settings.");
                }

                throw error;
            }

            const reported = await readGeolocation(
                context.access, targetId, origin, context.signal,
            );

            return {
                tab      : targetId,
                emulation: summarizeEmulation(context.emulation.snapshot(targetId)),
                ...(reported === undefined ? {} : { reported }),
            };
        });
    },
});
