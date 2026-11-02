import { z } from "zod";
import type { TabEmulation } from "./state.js";

export const emulationSummarySchema = z.strictObject({
    device: z.strictObject({
        name             : z.string().describe("Device name from the table, or Custom."),
        width            : z.number().describe("Applied CSS width."),
        height           : z.number().describe("Applied CSS height."),
        deviceScaleFactor: z.number().describe("Applied device pixel ratio."),
        mobile           : z.boolean().describe("Whether mobile viewport behavior is emulated."),
        touch            : z.boolean().describe("Whether touch input is emulated."),
        userAgent        : z.string().describe("Applied user agent."),
        landscape        : z.boolean().describe("Whether the size is landscape."),
    }).optional().describe("Device override, when active."),
    media: z.strictObject({
        media        : z.string().describe("Emulated media type, empty when unset."),
        colorScheme  : z.string().optional().describe("Emulated prefers-color-scheme, when set."),
        reducedMotion: z.string().optional().describe("Emulated prefers-reduced-motion, when set."),
        contrast     : z.string().optional().describe("Emulated prefers-contrast, when set."),
        forcedColors : z.string().optional().describe("Emulated forced-colors, when set."),
    }).optional().describe("Media overrides, when active."),
    network: z.strictObject({
        preset      : z.string().optional().describe("Preset name, when set from a preset."),
        offline     : z.boolean().describe("Whether the tab is offline."),
        latencyMs   : z.number().describe("Added latency in milliseconds."),
        downloadKbps: z.number().describe("Download ceiling in Kbps, -1 when unset."),
        uploadKbps  : z.number().describe("Upload ceiling in Kbps, -1 when unset."),
        blockUrls   : z.array(z.string()).describe("Blocked URL patterns."),
    }).optional().describe("Network overrides, when active."),
    locale: z.strictObject({
        locale        : z.string().optional().describe("ICU locale override, when set."),
        timezone      : z.string().optional().describe("Timezone override, when set."),
        acceptLanguage: z.string().optional().describe("Accept-Language override, when set."),
    }).optional().describe("Locale overrides, when set."),
});

export type EmulationSummary = z.infer<typeof emulationSummarySchema>;

export function summarizeEmulation(state: TabEmulation): EmulationSummary {
    return {
        ...(state.device === undefined ? {} : {
            device: {
                name             : state.device.name,
                width            : state.device.width,
                height           : state.device.height,
                deviceScaleFactor: state.device.deviceScaleFactor,
                mobile           : state.device.mobile,
                touch            : state.device.touch,
                userAgent        : state.device.userAgent,
                landscape        : state.device.landscape,
            },
        }),
        ...(state.media === undefined ? {} : {
            media: {
                media        : state.media.media,
                colorScheme  : state.media.colorScheme,
                reducedMotion: state.media.reducedMotion,
                contrast     : state.media.contrast,
                forcedColors : state.media.forcedColors,
            },
        }),
        ...(state.network === undefined ? {} : {
            network: {
                ...(state.network.preset === undefined ? {} : { preset: state.network.preset }),
                offline     : state.network.offline,
                latencyMs   : state.network.latencyMs,
                downloadKbps: state.network.downloadKbps,
                uploadKbps  : state.network.uploadKbps,
                blockUrls   : [...state.network.blockUrls],
            },
        }),
        ...(state.locale === undefined ? {} : {
            locale: {
                ...(state.locale.locale === undefined ? {} : { locale: state.locale.locale }),
                ...(state.locale.timezone === undefined ? {} : { timezone: state.locale.timezone }),
                ...(state.locale.acceptLanguage === undefined
                    ? {}
                    : { acceptLanguage: state.locale.acceptLanguage }),
            },
        }),
    };
}
