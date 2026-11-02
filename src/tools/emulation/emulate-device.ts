import { z } from "zod";
import type { DaemonAccess } from "../../mcp/index.js";
import { defineTool, type ToolContext } from "../define-tool.js";
import { ensureNoDialog } from "../dialogs.js";
import { ToolError } from "../errors.js";
import { throwIfCancelled } from "../registry.js";
import {
    buildDeviceCommands,
    buildDeviceResetCommands,
    buildUserAgentCommand,
    deviceMetricsOf,
    resolveDevice,
    type CdpCommand,
    type DeviceMetrics,
} from "./commands.js";
import {
    DEVICE_HEIGHT_MAX,
    DEVICE_HEIGHT_MIN,
    DEVICE_SCALE_MAX,
    DEVICE_SCALE_MIN,
    DEVICE_USER_AGENT_MAX_CHARS,
    DEVICE_WIDTH_MAX,
    DEVICE_WIDTH_MIN,
} from "./devices.js";
import { readDevice, type DeviceRead } from "./reads.js";
import { runSteps } from "./steps.js";
import { emulationSummarySchema, summarizeEmulation } from "./summary.js";

const reportedSchema = z.strictObject({
    innerWidth      : z.number().describe("Inner CSS width the page reports."),
    innerHeight     : z.number().describe("Inner CSS height the page reports."),
    devicePixelRatio: z.number().describe("Device pixel ratio the page reports."),
    userAgent       : z.string().describe("User agent the page reports."),
    maxTouchPoints  : z.number().describe("Touch points the page reports."),
});

export interface DeviceInput {
    device           : string | undefined;
    width            : number | undefined;
    height           : number | undefined;
    deviceScaleFactor: number | undefined;
    mobile           : boolean | undefined;
    touch            : boolean | undefined;
    userAgent        : string | undefined;
    landscape        : boolean;
    reset            : boolean;
}

export function checkDeviceInput(input: DeviceInput): void {
    const branches = [
        input.device !== undefined,
        input.width !== undefined || input.height !== undefined ||
        input.deviceScaleFactor !== undefined || input.mobile !== undefined ||
        input.touch !== undefined || input.userAgent !== undefined,
        input.reset,
    ].filter((branch) => branch).length;

    if (branches !== 1) {
        throw new ToolError(
            "Provide exactly one of device, the explicit size fields, or reset: true.",
        );
    }

    if (input.device !== undefined || input.reset) return;

    const explicitComplete = input.width !== undefined && input.height !== undefined &&
        input.deviceScaleFactor !== undefined && input.mobile !== undefined &&
        input.touch !== undefined;

    if (explicitComplete) return;

    throw new ToolError(
        "Explicit emulation needs width, height, deviceScaleFactor, mobile and touch together. Use a device name or reset: true instead.",
    );
}

export function explicitMetrics(input: DeviceInput): DeviceMetrics {
    return {
        width            : input.landscape ? (input.height as number) : (input.width as number),
        height           : input.landscape ? (input.width as number) : (input.height as number),
        deviceScaleFactor: input.deviceScaleFactor as number,
        mobile           : input.mobile as boolean,
        touch            : input.touch as boolean,
    };
}

export async function applyDeviceReset(
    access  : DaemonAccess,
    targetId: string,
): Promise<void> {
    await sendCommands(access, targetId, buildDeviceResetCommands());
}

async function sendCommands(
    access  : DaemonAccess,
    targetId: string,
    commands: CdpCommand[],
): Promise<void> {
    for (const command of commands) {
        await access.send(targetId, command.method, command.params);
    }
}

export const emulateDevice = defineTool({
    name: "emulate_device",
    description:
        "Emulate a device size, pixel ratio, mobile viewport, touch and user agent on a tab. Reads back what the page reports. Client hints metadata is not emulated.",
    access: "mutate",
    input : z.strictObject({
        tab              : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        device           : z.string().min(1).max(128).optional().describe("Device name from list_devices, case insensitive."),
        width            : z.number().int().min(DEVICE_WIDTH_MIN).max(DEVICE_WIDTH_MAX).optional().describe("Explicit CSS width, 100 to 10000. Needs height, deviceScaleFactor, mobile and touch."),
        height           : z.number().int().min(DEVICE_HEIGHT_MIN).max(DEVICE_HEIGHT_MAX).optional().describe("Explicit CSS height, 100 to 10000."),
        deviceScaleFactor: z.number().min(DEVICE_SCALE_MIN).max(DEVICE_SCALE_MAX).optional().describe("Explicit pixel ratio, 0.5 to 5."),
        mobile           : z.boolean().optional().describe("Explicit mobile viewport behavior."),
        touch            : z.boolean().optional().describe("Explicit touch emulation."),
        userAgent        : z.string().min(1).max(DEVICE_USER_AGENT_MAX_CHARS).optional().describe("User agent for explicit emulation. Defaults to the real one."),
        landscape        : z.boolean().optional().describe("Swap width and height. Defaults to false."),
        reset            : z.boolean().optional().describe("Remove the device overrides of this tab. Defaults to false."),
    }),
    output: z.strictObject({
        tab      : z.string().describe("Tab id."),
        emulation: emulationSummarySchema.describe("Emulation state of the tab after the call."),
        reported : reportedSchema.optional().describe("Viewport and agent the page reports, when it answers."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        checkDeviceInput({
            device           : args.device,
            width            : args.width,
            height           : args.height,
            deviceScaleFactor: args.deviceScaleFactor,
            mobile           : args.mobile,
            touch            : args.touch,
            userAgent        : args.userAgent,
            landscape        : args.landscape ?? false,
            reset            : args.reset ?? false,
        });
        throwIfCancelled(context.signal);

        await ensureNoDialog(context.dialogs, targetId);

        const acceptLanguage = context.emulation.snapshot(targetId).locale?.acceptLanguage;

        if (args.reset === true) {
            const agent = buildUserAgentCommand({ userAgent: undefined, acceptLanguage });

            await runSteps(context.access, context.signal, targetId, [
                { commands: agent ? [agent] : [], record: () => undefined },
                {
                    commands: buildDeviceResetCommands(),
                    record  : () => context.emulation.resetDevice(targetId),
                },
            ]);

            return {
                tab      : targetId,
                emulation: summarizeEmulation(context.emulation.snapshot(targetId)),
                ...await reportedOf(context, targetId),
            };
        }

        const selection = selectMetrics(args);
        const previous = context.emulation.snapshot(targetId).device;
        const agent = buildUserAgentCommand({ userAgent: selection.userAgent, acceptLanguage });
        const previousAgent = buildUserAgentCommand({
            userAgent: previous?.userAgent === "" ? undefined : previous?.userAgent,
            acceptLanguage,
        });
        const restore = () => {
            if (previous === undefined) context.emulation.resetDevice(targetId);
            else context.emulation.applyDevice(targetId, previous);
        };
        const applied = {
            ...selection.metrics,
            name     : selection.name,
            landscape: selection.landscape,
        };

        await runSteps(context.access, context.signal, targetId, [
            {
                commands: buildDeviceCommands(selection.metrics, selection.landscape),
                record  : () => context.emulation.applyDevice(targetId, {
                    ...applied,
                    userAgent: previous?.userAgent ?? "",
                }),
                undo: previous === undefined
                    ? buildDeviceResetCommands()
                    : buildDeviceCommands(previous, previous.landscape),
                unrecord: restore,
            },
            {
                commands: agent ? [agent] : [],
                record  : () => context.emulation.applyDevice(targetId, {
                    ...applied,
                    userAgent: selection.userAgent ?? "",
                }),
                undo    : previousAgent ? [previousAgent] : [],
                unrecord: restore,
            },
        ]);

        const reported = await readDevice(context.access, targetId, context.signal);

        if (selection.userAgent === undefined && reported !== undefined) {
            context.emulation.applyDevice(targetId, { ...applied, userAgent: reported.userAgent });
        }

        return {
            tab      : targetId,
            emulation: summarizeEmulation(context.emulation.snapshot(targetId)),
            ...(reported === undefined ? {} : { reported }),
        };
    },
});

function selectMetrics(args: {
    device?           : string | undefined;
    width?            : number | undefined;
    height?           : number | undefined;
    deviceScaleFactor?: number | undefined;
    mobile?           : boolean | undefined;
    touch?            : boolean | undefined;
    userAgent?        : string | undefined;
    landscape?        : boolean | undefined;
}): { metrics: DeviceMetrics; landscape: boolean; userAgent: string | undefined; name: string } {
    const landscape = args.landscape ?? false;

    if (args.device !== undefined) {
        const device = resolveDevice(args.device);

        return {
            metrics  : deviceMetricsOf(device, landscape),
            landscape,
            userAgent: device.userAgent,
            name     : device.name,
        };
    }

    const metrics = explicitMetrics({
        device           : undefined,
        width            : args.width,
        height           : args.height,
        deviceScaleFactor: args.deviceScaleFactor,
        mobile           : args.mobile,
        touch            : args.touch,
        userAgent        : args.userAgent,
        landscape,
        reset            : false,
    });

    return { metrics, landscape, userAgent: args.userAgent, name: "Custom" };
}

async function reportedOf(
    context : ToolContext,
    targetId: string,
): Promise<{ reported?: DeviceRead }> {
    const reported = await readDevice(context.access, targetId, context.signal);

    return reported === undefined ? {} : { reported };
}
