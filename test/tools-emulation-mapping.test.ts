import { describe, expect, it } from "vitest";
import {
    asLandscape,
    BLOCK_URL_MAX_CHARS,
    BLOCK_URLS_MAX,
    buildBlockedUrlsCommands,
    buildDeviceCommands,
    buildDeviceResetCommands,
    buildLocaleCommands,
    buildLocaleResetCommands,
    buildMediaCommands,
    buildMediaResetCommands,
    buildNetworkCommands,
    buildNetworkResetCommands,
    buildUserAgentCommand,
    canonicalLocale,
    checkAcceptLanguage,
    checkDeviceInput,
    checkNetworkInput,
    checkedTimezone,
    conditionsOf,
    DEVICE_HEIGHT_MAX,
    DEVICE_HEIGHT_MIN,
    DEVICE_SCALE_MAX,
    DEVICE_SCALE_MIN,
    DEVICE_USER_AGENT_MAX_CHARS,
    DEVICE_WIDTH_MAX,
    DEVICE_WIDTH_MIN,
    deviceMetricsOf,
    DEVICES,
    EmulationState,
    explicitMetrics,
    filterDevices,
    findDevice,
    hasLocaleSelection,
    hasMediaSelection,
    mergeMedia,
    NETWORK_LATENCY_MAX_MS,
    NETWORK_PRESETS,
    NETWORK_THROUGHPUT_MAX_KBPS,
    orientationOf,
    presetConditions,
    resolveDevice,
    suggestDevices,
    summarizeEmulation,
    TOUCH_POINTS_DEFAULT,
} from "../src/tools/index.js";

describe("devices table", () => {
    it("holds 15 to 25 entries with unique names and sane ranges", () => {
        expect(DEVICES.length).toBeGreaterThanOrEqual(15);
        expect(DEVICES.length).toBeLessThanOrEqual(25);

        const names = DEVICES.map((device) => device.name);

        expect(new Set(names).size).toBe(names.length);

        for (const device of DEVICES) {
            expect(device.width).toBeGreaterThanOrEqual(DEVICE_WIDTH_MIN);
            expect(device.width).toBeLessThanOrEqual(DEVICE_WIDTH_MAX);
            expect(device.height).toBeGreaterThanOrEqual(DEVICE_HEIGHT_MIN);
            expect(device.height).toBeLessThanOrEqual(DEVICE_HEIGHT_MAX);
            expect(device.deviceScaleFactor).toBeGreaterThanOrEqual(DEVICE_SCALE_MIN);
            expect(device.deviceScaleFactor).toBeLessThanOrEqual(DEVICE_SCALE_MAX);
            expect(device.userAgent.length).toBeGreaterThan(0);
            expect(device.userAgent.length).toBeLessThanOrEqual(DEVICE_USER_AGENT_MAX_CHARS);

            if (device.mobile) expect(device.touch).toBe(true);
        }

        const kinds = new Set(DEVICES.map((device) => device.kind));

        expect(kinds).toEqual(new Set(["phone", "tablet", "desktop"]));
    });

    it("filters by kind and by a case insensitive name query", () => {
        expect(filterDevices({ kind: "phone" }).every((device) => device.kind === "phone")).toBe(true);
        expect(filterDevices({ kind: "tablet" }).length).toBeGreaterThan(0);
        expect(filterDevices({ kind: "desktop" }).length).toBeGreaterThan(0);
        expect(filterDevices({ query: "iphone" }).map((device) => device.name))
            .toContain("iPhone 14");
        expect(filterDevices({ query: "PIXEL", kind: "phone" }).length).toBeGreaterThan(0);
        expect(filterDevices({ query: "no such device" })).toEqual([]);
    });

    it("exposes the swapped landscape size", () => {
        const phone = DEVICES.find((device) => device.name === "iPhone 14");

        expect(phone).toBeDefined();

        const landscape = asLandscape(phone as (typeof DEVICES)[number]);

        expect(landscape.landscapeWidth).toBe(phone?.height);
        expect(landscape.landscapeHeight).toBe(phone?.width);
    });

    it("resolves names case insensitively and suggests close names", () => {
        expect(findDevice("  pixel 7 "))?.toMatchObject({ name: "Pixel 7" });
        expect(resolveDevice("galaxy s23")).toMatchObject({ name: "Galaxy S23" });
        expect(suggestDevices("iPhon 14")).toContain("iPhone 14");

        expect(() => resolveDevice("Nokia 3310")).toThrow(/Did you mean one of/);
        expect(() => resolveDevice("Nokia 3310")).toThrow(/list_devices/);
    });
});

describe("device mapping", () => {
    it("swaps the size and orientation for landscape", () => {
        const phone = resolveDevice("iPhone 14");

        expect(deviceMetricsOf(phone, false)).toEqual({
            width            : 390,
            height           : 844,
            deviceScaleFactor: 3,
            mobile           : true,
            touch            : true,
        });
        expect(deviceMetricsOf(phone, true)).toEqual({
            width            : 844,
            height           : 390,
            deviceScaleFactor: 3,
            mobile           : true,
            touch            : true,
        });
        expect(orientationOf(false)).toEqual({ type: "portraitPrimary", angle: 0 });
        expect(orientationOf(true)).toEqual({ type: "landscapePrimary", angle: 90 });
    });

    it("emits metrics and touch commands in order for a touch device", () => {
        const commands = buildDeviceCommands(deviceMetricsOf(resolveDevice("Pixel 7"), false), false);

        expect(commands.map((command) => command.method)).toEqual([
            "Emulation.setDeviceMetricsOverride",
            "Emulation.setTouchEmulationEnabled",
            "Emulation.setEmitTouchEventsForMouse",
        ]);
        expect(commands[0]?.params).toMatchObject({
            width            : 412,
            height           : 915,
            deviceScaleFactor: 2.625,
            mobile           : true,
            screenOrientation: { type: "portraitPrimary", angle: 0 },
        });
        expect(commands[1]?.params).toEqual({
            enabled       : true,
            maxTouchPoints: TOUCH_POINTS_DEFAULT,
        });
        expect(commands[2]?.params).toEqual({ enabled: true });
    });

    it("turns touch off for a desktop device", () => {
        const commands = buildDeviceCommands(
            deviceMetricsOf(resolveDevice("Windows Laptop 1080p"), false),
            false,
        );

        expect(commands.map((command) => command.method)).toEqual([
            "Emulation.setDeviceMetricsOverride",
            "Emulation.setEmitTouchEventsForMouse",
            "Emulation.setTouchEmulationEnabled",
        ]);
        expect(commands[1]?.params).toEqual({ enabled: false });
        expect(commands[2]?.params).toEqual({ enabled: false });
    });

    it("clears metrics and touch on reset in order", () => {
        expect(buildDeviceResetCommands()).toEqual([
            { method: "Emulation.clearDeviceMetricsOverride", params: {} },
            { method: "Emulation.setEmitTouchEventsForMouse", params: { enabled: false } },
            { method: "Emulation.setTouchEmulationEnabled", params: { enabled: false } },
        ]);
    });

    it("requires exactly one of device, explicit fields or reset", () => {
        const bare = {
            device           : undefined,
            width            : undefined,
            height           : undefined,
            deviceScaleFactor: undefined,
            mobile           : undefined,
            touch            : undefined,
            userAgent        : undefined,
            landscape        : false,
            reset            : false,
        };

        expect(() => checkDeviceInput(bare)).toThrow(/exactly one/);
        expect(() => checkDeviceInput({ ...bare, device: "Pixel 7", reset: true }))
            .toThrow(/exactly one/);
        expect(() => checkDeviceInput({ ...bare, device: "Pixel 7", width: 100 }))
            .toThrow(/exactly one/);
        expect(() => checkDeviceInput({ ...bare, device: "Pixel 7" })).not.toThrow();
        expect(() => checkDeviceInput({ ...bare, reset: true })).not.toThrow();
        expect(() => checkDeviceInput({ ...bare, width: 800 })).toThrow(/needs width, height/);
        expect(() =>
            checkDeviceInput({
                ...bare,
                width            : 800,
                height           : 600,
                deviceScaleFactor: 1,
                mobile           : false,
                touch            : true,
            }),
        ).not.toThrow();
    });

    it("swaps explicit sizes for landscape", () => {
        expect(explicitMetrics({
            device           : undefined,
            width            : 800,
            height           : 600,
            deviceScaleFactor: 2,
            mobile           : false,
            touch            : false,
            userAgent        : undefined,
            landscape        : true,
            reset            : false,
        })).toEqual({ width: 600, height: 800, deviceScaleFactor: 2, mobile: false, touch: false });
    });
});

describe("user agent override owner", () => {
    it("restores the real agent with an empty string when nothing is set", () => {
        expect(buildUserAgentCommand({ userAgent: undefined, acceptLanguage: undefined })).toEqual({
            method: "Emulation.setUserAgentOverride",
            params: { userAgent: "" },
        });
    });

    it("keeps the device agent when a locale is added and removed", () => {
        const device = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)";

        expect(buildUserAgentCommand({ userAgent: device, acceptLanguage: "de-DE" })).toEqual({
            method: "Emulation.setUserAgentOverride",
            params: { userAgent: device, acceptLanguage: "de-DE" },
        });
        expect(buildUserAgentCommand({ userAgent: device, acceptLanguage: undefined })).toEqual({
            method: "Emulation.setUserAgentOverride",
            params: { userAgent: device },
        });
    });

    it("keeps the accept language when a device is added and removed", () => {
        expect(buildUserAgentCommand({ userAgent: undefined, acceptLanguage: "de-DE" })).toEqual({
            method: "Emulation.setUserAgentOverride",
            params: { userAgent: "", acceptLanguage: "de-DE" },
        });
    });
});

describe("media mapping", () => {
    it("merges a partial call over the previous state", () => {
        const merged = mergeMedia(
            {
                media        : "print",
                colorScheme  : "dark",
                reducedMotion: "reduce",
                contrast     : "no-preference",
                forcedColors : "none",
                reducedData  : "no-preference",
            },
            { colorScheme: "light" },
        );

        expect(merged).toEqual({
            media        : "print",
            colorScheme  : "light",
            reducedMotion: "reduce",
            contrast     : "no-preference",
            forcedColors : "none",
            reducedData  : "no-preference",
        });
    });

    it("starts from the browser defaults without previous state", () => {
        expect(mergeMedia(undefined, { media: "screen" })).toEqual({
            media        : "screen",
            colorScheme  : "no-preference",
            reducedMotion: "no-preference",
            contrast     : "no-preference",
            forcedColors : "none",
            reducedData  : "no-preference",
        });
    });

    it("emits one setEmulatedMedia with every feature and clears on reset", () => {
        const commands = buildMediaCommands({
            media        : "print",
            colorScheme  : "dark",
            reducedMotion: "reduce",
            contrast     : "more",
            forcedColors : "active",
            reducedData  : "reduce",
        });

        expect(commands).toEqual([{
            method: "Emulation.setEmulatedMedia",
            params: {
                media   : "print",
                features: [
                    { name: "prefers-color-scheme", value: "dark" },
                    { name: "prefers-reduced-motion", value: "reduce" },
                    { name: "prefers-contrast", value: "more" },
                    { name: "forced-colors", value: "active" },
                    { name: "prefers-reduced-data", value: "reduce" },
                ],
            },
        }]);
        expect(buildMediaResetCommands()).toEqual([{
            method: "Emulation.setEmulatedMedia",
            params: { media: "", features: [] },
        }]);
    });

    it("detects an empty selection", () => {
        expect(hasMediaSelection({ reset: false })).toBe(false);
        expect(hasMediaSelection({ reset: true })).toBe(true);
        expect(hasMediaSelection({ reset: false, media: "print" })).toBe(true);
    });
});

describe("network mapping", () => {
    it("defines every preset with documented numbers", () => {
        expect(NETWORK_PRESETS).toEqual({
            offline  : { offline: true, latencyMs: 0, downloadKbps: 0, uploadKbps: 0 },
            "slow-3g": { offline: false, latencyMs: 2000, downloadKbps: 400, uploadKbps: 400 },
            "fast-3g": { offline: false, latencyMs: 562, downloadKbps: 1600, uploadKbps: 750 },
            "4g"     : { offline: false, latencyMs: 170, downloadKbps: 9000, uploadKbps: 9000 },
            wifi     : { offline: false, latencyMs: 28, downloadKbps: 30000, uploadKbps: 15000 },
            none     : { offline: false, latencyMs: 0, downloadKbps: -1, uploadKbps: -1 },
        });
        expect(presetConditions("4g")).toEqual(NETWORK_PRESETS["4g"]);
        expect(presetConditions("4g")).not.toBe(NETWORK_PRESETS["4g"]);
    });

    it("converts Kbps to bytes per second for CDP", () => {
        expect(buildNetworkCommands(presetConditions("slow-3g"))).toEqual([{
            method: "Network.emulateNetworkConditions",
            params: {
                offline           : false,
                latency           : 2000,
                downloadThroughput: 50000,
                uploadThroughput  : 50000,
            },
        }]);
        expect(buildNetworkCommands(presetConditions("offline"))).toEqual([{
            method: "Network.emulateNetworkConditions",
            params: { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
        }]);
    });

    it("restores the connection and clears blocked urls on reset", () => {
        expect(buildNetworkResetCommands()).toEqual([
            {
                method: "Network.emulateNetworkConditions",
                params: {
                    offline           : false,
                    latency           : 0,
                    downloadThroughput: -1,
                    uploadThroughput  : -1,
                },
            },
            { method: "Network.setBlockedURLs", params: { urls: [] } },
        ]);
        expect(BLOCK_URLS_MAX).toBe(50);
        expect(BLOCK_URL_MAX_CHARS).toBe(200);
        expect(NETWORK_LATENCY_MAX_MS).toBe(60_000);
        expect(NETWORK_THROUGHPUT_MAX_KBPS).toBe(1_000_000);
    });

    it("blocks urls with the CDP wildcard list", () => {
        expect(buildBlockedUrlsCommands(["*/ping", "*.css"])).toEqual([{
            method: "Network.setBlockedURLs",
            params: { urls: ["*/ping", "*.css"] },
        }]);
    });

    it("rejects mixed presets, custom fields and reset", () => {
        const bare = {
            preset      : undefined,
            latencyMs   : undefined,
            downloadKbps: undefined,
            uploadKbps  : undefined,
            offline     : undefined,
            blockUrls   : undefined,
            reset       : false,
        };

        expect(() => checkNetworkInput(bare)).toThrow(/Nothing was changed/);
        expect(() => checkNetworkInput({ ...bare, preset: "4g", latencyMs: 10 }))
            .toThrow(/either preset or the custom/);
        expect(() => checkNetworkInput({ ...bare, reset: true, preset: "none" }))
            .toThrow(/takes no other/);
        expect(() => checkNetworkInput({ ...bare, preset: "wifi" })).not.toThrow();
        expect(() => checkNetworkInput({ ...bare, blockUrls: ["*/x"] })).not.toThrow();
        expect(() => checkNetworkInput({ ...bare, reset: true })).not.toThrow();
    });

    it("merges custom fields over the previous conditions", () => {
        expect(conditionsOf(
            {
                preset      : undefined,
                latencyMs   : 100,
                downloadKbps: undefined,
                uploadKbps  : undefined,
                offline     : undefined,
                blockUrls   : undefined,
                reset       : false,
            },
            { offline: false, latencyMs: 10, downloadKbps: 100, uploadKbps: 50 },
        )).toEqual({ offline: false, latencyMs: 100, downloadKbps: 100, uploadKbps: 50 });
        expect(conditionsOf(
            {
                preset      : undefined,
                latencyMs   : undefined,
                downloadKbps: undefined,
                uploadKbps  : undefined,
                offline     : undefined,
                blockUrls   : ["*/x"],
                reset       : false,
            },
            undefined,
        )).toEqual({ offline: false, latencyMs: 0, downloadKbps: -1, uploadKbps: -1 });
    });
});

describe("locale mapping", () => {
    it("emits locale and timezone commands only for the given fields", () => {
        expect(buildLocaleCommands({ locale: "de-DE", timezone: "Europe/Berlin", acceptLanguage: undefined }))
            .toEqual([
                { method: "Emulation.setLocaleOverride", params: { locale: "de-DE" } },
                { method: "Emulation.setTimezoneOverride", params: { timezoneId: "Europe/Berlin" } },
            ]);
        expect(buildLocaleCommands({ locale: undefined, timezone: "Asia/Tokyo", acceptLanguage: "de" }))
            .toEqual([
                { method: "Emulation.setTimezoneOverride", params: { timezoneId: "Asia/Tokyo" } },
            ]);
    });

    it("resets only the overrides that were set", () => {
        expect(buildLocaleResetCommands({ locale: "de-DE", timezone: undefined, acceptLanguage: "de" }))
            .toEqual([{ method: "Emulation.setLocaleOverride", params: {} }]);
        expect(buildLocaleResetCommands({ locale: "de-DE", timezone: "Asia/Tokyo", acceptLanguage: undefined }))
            .toEqual([
                { method: "Emulation.setLocaleOverride", params: {} },
                { method: "Emulation.setTimezoneOverride", params: { timezoneId: "" } },
            ]);
    });

    it("validates BCP 47 locales and IANA timezones", () => {
        expect(canonicalLocale("de-de")).toBe("de-DE");
        expect(checkedTimezone("Europe/Berlin")).toBe("Europe/Berlin");
        expect(() => canonicalLocale("not a locale !!!")).toThrow(/not a valid BCP 47/);
        expect(() => checkedTimezone("Mars/Olympus")).toThrow(/not a valid IANA/);
    });

    it("accepts printable ASCII accept language values only", () => {
        expect(() => checkAcceptLanguage("de-DE,de;q=0.9")).not.toThrow();
        expect(() => checkAcceptLanguage("de-DE\nInjected: x")).toThrow(/printable ASCII/);
        expect(() => checkAcceptLanguage("de-DE,fr-FR;q=0.8")).not.toThrow();
    });

    it("detects an empty selection", () => {
        expect(hasLocaleSelection({ reset: false })).toBe(false);
        expect(hasLocaleSelection({ reset: true })).toBe(true);
        expect(hasLocaleSelection({ reset: false, timezone: "Asia/Tokyo" })).toBe(true);
    });
});

describe("EmulationState", () => {
    it("applies, merges and resets each override independently", () => {
        const state = new EmulationState();

        state.applyDevice("tab1", {
            name             : "Pixel 7",
            width            : 412,
            height           : 915,
            deviceScaleFactor: 2.625,
            mobile           : true,
            touch            : true,
            userAgent        : "agent",
            landscape        : false,
        });
        state.applyMedia("tab1", mergeMedia(undefined, { colorScheme: "dark" }));

        expect(state.snapshot("tab1").device?.name).toBe("Pixel 7");
        expect(state.snapshot("tab1").media?.colorScheme).toBe("dark");

        state.resetDevice("tab1");

        expect(state.snapshot("tab1").device).toBeUndefined();
        expect(state.snapshot("tab1").media?.colorScheme).toBe("dark");
    });

    it("keeps tabs apart and clears on forget and reset", () => {
        const state = new EmulationState();

        state.applyNetwork("tab1", {
            offline     : true,
            latencyMs   : 0,
            downloadKbps: 0,
            uploadKbps  : 0,
            preset      : "offline",
            blockUrls   : [],
        });
        state.applyLocale("tab2", { locale: "de-DE", timezone: undefined, acceptLanguage: undefined });

        expect(state.snapshot("tab1").network?.offline).toBe(true);
        expect(state.snapshot("tab1").locale).toBeUndefined();

        state.forget("tab1");

        expect(state.snapshot("tab1").network).toBeUndefined();
        expect(state.snapshot("tab2").locale?.locale).toBe("de-DE");

        state.reset();

        expect(state.snapshot("tab2").locale).toBeUndefined();
    });

    it("drops empty tab entries so the summary stays small", () => {
        const state = new EmulationState();

        state.applyDevice("tab1", {
            name             : "Custom",
            width            : 800,
            height           : 600,
            deviceScaleFactor: 1,
            mobile           : false,
            touch            : false,
            userAgent        : "",
            landscape        : false,
        });
        state.resetDevice("tab1");

        expect(summarizeEmulation(state.snapshot("tab1"))).toEqual({});
    });

    it("summarizes every override for page_info and the tools", () => {
        const state = new EmulationState();

        state.applyDevice("tab1", {
            name             : "Pixel 7",
            width            : 412,
            height           : 915,
            deviceScaleFactor: 2.625,
            mobile           : true,
            touch            : true,
            userAgent        : "agent",
            landscape        : false,
        });
        state.applyMedia("tab1", mergeMedia(undefined, { media: "print", colorScheme: "dark" }));
        state.applyNetwork("tab1", {
            offline     : false,
            latencyMs   : 170,
            downloadKbps: 1125,
            uploadKbps  : 750,
            preset      : "4g",
            blockUrls   : ["*/ping"],
        });
        state.applyLocale("tab1", { locale: "de-DE", timezone: "Europe/Berlin", acceptLanguage: "de" });

        expect(summarizeEmulation(state.snapshot("tab1"))).toEqual({
            device: {
                name             : "Pixel 7",
                width            : 412,
                height           : 915,
                deviceScaleFactor: 2.625,
                mobile           : true,
                touch            : true,
                userAgent        : "agent",
                landscape        : false,
            },
            media: {
                media        : "print",
                colorScheme  : "dark",
                reducedMotion: "no-preference",
                contrast     : "no-preference",
                forcedColors : "none",
                reducedData  : "no-preference",
            },
            network: {
                preset      : "4g",
                offline     : false,
                latencyMs   : 170,
                downloadKbps: 1125,
                uploadKbps  : 750,
                blockUrls   : ["*/ping"],
            },
            locale: { locale: "de-DE", timezone: "Europe/Berlin", acceptLanguage: "de" },
        });
    });
});
