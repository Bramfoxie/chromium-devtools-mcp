import { ToolError } from "../errors.js";
import { findDevice, suggestDevices, type DeviceSpec } from "./devices.js";

export interface CdpCommand {
    method: string;
    params: Record<string, unknown>;
}

export interface DeviceMetrics {
    width            : number;
    height           : number;
    deviceScaleFactor: number;
    mobile           : boolean;
    touch            : boolean;
}

export interface DeviceSelection {
    device   : DeviceSpec;
    landscape: boolean;
    touch    : boolean;
}

export interface MediaSelection {
    media?        : "" | "screen" | "print";
    colorScheme?  : "light" | "dark" | "no-preference";
    reducedMotion?: "reduce" | "no-preference";
    contrast?     : "more" | "less" | "no-preference";
    forcedColors? : "active" | "none";
    reducedData?  : "reduce" | "no-preference";
}

export interface MediaState {
    media        : "" | "screen" | "print";
    colorScheme  : "light" | "dark" | "no-preference";
    reducedMotion: "reduce" | "no-preference";
    contrast     : "more" | "less" | "no-preference";
    forcedColors : "active" | "none";
    reducedData  : "reduce" | "no-preference";
}

export interface NetworkConditions {
    offline     : boolean;
    latencyMs   : number;
    downloadKbps: number;
    uploadKbps  : number;
}

export type NetworkPresetName = "offline" | "slow-3g" | "fast-3g" | "4g" | "wifi" | "none";

export const NETWORK_PRESETS: Record<NetworkPresetName, NetworkConditions> = {
    offline  : { offline: true, latencyMs: 0, downloadKbps: 0, uploadKbps: 0 },
    "slow-3g": { offline: false, latencyMs: 2000, downloadKbps: 50, uploadKbps: 20 },
    "fast-3g": { offline: false, latencyMs: 562, downloadKbps: 187, uploadKbps: 93 },
    "4g"     : { offline: false, latencyMs: 170, downloadKbps: 1125, uploadKbps: 750 },
    wifi     : { offline: false, latencyMs: 28, downloadKbps: 3750, uploadKbps: 1875 },
    none     : { offline: false, latencyMs: 0, downloadKbps: -1, uploadKbps: -1 },
};

export const NETWORK_LATENCY_MAX_MS = 60_000;

export const NETWORK_THROUGHPUT_MAX_KBPS = 1_000_000;

export const BLOCK_URLS_MAX = 50;

export const BLOCK_URL_MAX_CHARS = 200;

export interface UserAgentParts {
    userAgent     : string | undefined;
    acceptLanguage: string | undefined;
}

export interface LocaleSelection {
    locale        : string | undefined;
    timezone      : string | undefined;
    acceptLanguage: string | undefined;
}

export const TOUCH_POINTS_DEFAULT = 5;

export function resolveDevice(name: string): DeviceSpec {
    const device = findDevice(name);

    if (device) return device;

    const suggestions = suggestDevices(name).join(", ");

    throw new ToolError(
        `No device named ${JSON.stringify(name)}. Did you mean one of: ${suggestions}? Call list_devices to see every device.`,
    );
}

export function deviceMetricsOf(device: DeviceSpec, landscape: boolean): DeviceMetrics {
    return {
        width            : landscape ? device.height : device.width,
        height           : landscape ? device.width : device.height,
        deviceScaleFactor: device.deviceScaleFactor,
        mobile           : device.mobile,
        touch            : device.touch,
    };
}

export function orientationOf(landscape: boolean): { type: string; angle: number } {
    return landscape ? { type: "landscapePrimary", angle: 90 } : { type: "portraitPrimary", angle: 0 };
}

export function buildDeviceCommands(metrics: DeviceMetrics, landscape: boolean): CdpCommand[] {
    const commands: CdpCommand[] = [
        {
            method: "Emulation.setDeviceMetricsOverride",
            params: {
                width            : metrics.width,
                height           : metrics.height,
                deviceScaleFactor: metrics.deviceScaleFactor,
                mobile           : metrics.mobile,
                screenOrientation: orientationOf(landscape),
            },
        },
    ];

    if (metrics.touch) {
        commands.push({
            method: "Emulation.setTouchEmulationEnabled",
            params: { enabled: true, maxTouchPoints: TOUCH_POINTS_DEFAULT },
        });
        commands.push({
            method: "Emulation.setEmitTouchEventsForMouse",
            params: { enabled: true },
        });
    } else {
        commands.push({
            method: "Emulation.setEmitTouchEventsForMouse",
            params: { enabled: false },
        });
        commands.push({
            method: "Emulation.setTouchEmulationEnabled",
            params: { enabled: false },
        });
    }

    return commands;
}

export function buildDeviceResetCommands(): CdpCommand[] {
    return [
        { method: "Emulation.clearDeviceMetricsOverride", params: {} },
        { method: "Emulation.setEmitTouchEventsForMouse", params: { enabled: false } },
        { method: "Emulation.setTouchEmulationEnabled", params: { enabled: false } },
    ];
}

// Single owner of the setUserAgentOverride call: device and locale fields merge here,
// and one reset keeps the other side. An empty user agent restores the real one.
export function buildUserAgentCommand(parts: UserAgentParts): CdpCommand | undefined {
    if (parts.userAgent === undefined && parts.acceptLanguage === undefined) {
        return { method: "Emulation.setUserAgentOverride", params: { userAgent: "" } };
    }

    if (parts.userAgent === undefined) {
        return {
            method: "Emulation.setUserAgentOverride",
            params: { userAgent: "", acceptLanguage: parts.acceptLanguage },
        };
    }

    return {
        method: "Emulation.setUserAgentOverride",
        params: {
            userAgent: parts.userAgent,
            ...(parts.acceptLanguage === undefined ? {} : { acceptLanguage: parts.acceptLanguage }),
        },
    };
}

export function mergeMedia(
    previous : MediaState | undefined,
    selection: MediaSelection,
): MediaState {
    return {
        media        : selection.media ?? previous?.media ?? "",
        colorScheme  : selection.colorScheme ?? previous?.colorScheme ?? "no-preference",
        reducedMotion: selection.reducedMotion ?? previous?.reducedMotion ?? "no-preference",
        contrast     : selection.contrast ?? previous?.contrast ?? "no-preference",
        forcedColors : selection.forcedColors ?? previous?.forcedColors ?? "none",
        reducedData  : selection.reducedData ?? previous?.reducedData ?? "no-preference",
    };
}

export function buildMediaCommands(state: MediaState): CdpCommand[] {
    const features = [
        { name: "prefers-color-scheme", value: state.colorScheme },
        { name: "prefers-reduced-motion", value: state.reducedMotion },
        { name: "prefers-contrast", value: state.contrast },
        { name: "forced-colors", value: state.forcedColors },
        { name: "prefers-reduced-data", value: state.reducedData },
    ];

    return [{ method: "Emulation.setEmulatedMedia", params: { media: state.media, features } }];
}

export function buildMediaResetCommands(): CdpCommand[] {
    return [{ method: "Emulation.setEmulatedMedia", params: { media: "", features: [] } }];
}

export function presetConditions(preset: NetworkPresetName): NetworkConditions {
    return { ...NETWORK_PRESETS[preset] };
}

function toBytesPerSecond(kbps: number, offline: boolean): number {
    if (offline) return -1;

    return Math.round((kbps * 1024) / 8);
}

export function buildNetworkCommands(conditions: NetworkConditions): CdpCommand[] {
    return [
        {
            method: "Network.emulateNetworkConditions",
            params: {
                offline           : conditions.offline,
                latency           : conditions.latencyMs,
                downloadThroughput: toBytesPerSecond(conditions.downloadKbps, conditions.offline),
                uploadThroughput  : toBytesPerSecond(conditions.uploadKbps, conditions.offline),
            },
        },
    ];
}

export function buildNetworkResetCommands(): CdpCommand[] {
    return [
        {
            method: "Network.emulateNetworkConditions",
            params: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
        },
        { method: "Network.setBlockedURLs", params: { urls: [] } },
    ];
}

export function buildBlockedUrlsCommands(patterns: string[]): CdpCommand[] {
    return [{ method: "Network.setBlockedURLs", params: { urls: patterns } }];
}

export function buildLocaleCommands(selection: LocaleSelection): CdpCommand[] {
    const commands: CdpCommand[] = [];

    if (selection.locale !== undefined) {
        commands.push({ method: "Emulation.setLocaleOverride", params: { locale: selection.locale } });
    }

    if (selection.timezone !== undefined) {
        commands.push({ method: "Emulation.setTimezoneOverride", params: { timezoneId: selection.timezone } });
    }

    return commands;
}

export function buildLocaleResetCommands(previous: LocaleSelection): CdpCommand[] {
    const commands: CdpCommand[] = [];

    if (previous.locale !== undefined) {
        commands.push({ method: "Emulation.setLocaleOverride", params: {} });
    }

    if (previous.timezone !== undefined) {
        commands.push({ method: "Emulation.setTimezoneOverride", params: { timezoneId: "" } });
    }

    return commands;
}

export function canonicalLocale(locale: string): string {
    let canonical: string[];

    try {
        canonical = Intl.getCanonicalLocales(locale);
    } catch {
        throw new ToolError(
            `The locale ${JSON.stringify(locale)} is not a valid BCP 47 tag. Use a tag like de-DE.`,
        );
    }

    if (canonical.length === 0) {
        throw new ToolError(
            `The locale ${JSON.stringify(locale)} is not a valid BCP 47 tag. Use a tag like de-DE.`,
        );
    }

    return canonical[0] as string;
}

export function checkedTimezone(timezone: string): string {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
        throw new ToolError(
            `The timezone ${JSON.stringify(timezone)} is not a valid IANA name. Use a name like Europe/Berlin.`,
        );
    }

    return timezone;
}
