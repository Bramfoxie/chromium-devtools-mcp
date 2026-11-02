import { z } from "zod";
import { defineTool } from "../define-tool.js";
import { deviceKindSchema, filterDevices } from "./devices.js";

const listedDevice = z.strictObject({
    name             : z.string().describe("Device name for emulate_device."),
    kind             : deviceKindSchema.describe("Phone, tablet or desktop."),
    width            : z.number().describe("CSS width in portrait."),
    height           : z.number().describe("CSS height in portrait."),
    deviceScaleFactor: z.number().describe("Device pixel ratio."),
    mobile           : z.boolean().describe("Whether mobile viewport behavior is emulated."),
    touch            : z.boolean().describe("Whether touch input is emulated."),
    userAgent        : z.string().describe("User agent sent with the device."),
    landscape        : z.strictObject({
        width : z.number().describe("CSS width in landscape."),
        height: z.number().describe("CSS height in landscape."),
    }).describe("Swapped portrait size."),
});

export const listDevices = defineTool({
    name       : "list_devices",
    closedWorld: true,
    description: "List the built in devices for emulate_device, with an optional name or kind filter.",
    access     : "read",
    input      : z.strictObject({
        query: z.string().min(1).max(128).optional().describe("Case insensitive substring filter on the name."),
        kind : deviceKindSchema.optional().describe("Keep only phones, tablets or desktops."),
    }),
    output: z.strictObject({
        devices: z.array(listedDevice).describe("Matching devices in table order."),
        total  : z.number().describe("Number of matching devices."),
    }),
    handler: async (args) => {
        const devices = filterDevices({ query: args.query, kind: args.kind });

        return {
            devices: devices.map((device) => ({
                name             : device.name,
                kind             : device.kind,
                width            : device.width,
                height           : device.height,
                deviceScaleFactor: device.deviceScaleFactor,
                mobile           : device.mobile,
                touch            : device.touch,
                userAgent        : device.userAgent,
                landscape        : { width: device.landscapeWidth, height: device.landscapeHeight },
            })),
            total: devices.length,
        };
    },
});
