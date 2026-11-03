import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { ErrorCode, IpcCancelledError, RpcError } from "../src/daemon/index.js";
import {
    DEVICE_READ_EXPRESSION,
    emulateDevice,
    emulateLocale,
    emulateMedia,
    emulateNetwork,
    listDevices,
    listTabs,
    LOCALE_READ_EXPRESSION,
    MEDIA_READ_EXPRESSION,
    newTab,
    pageInfo,
    readMedia,
    runTool,
    ToolRuntime,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const readOnly: Config = {
    ...managedConfig,
    safety: { ...managedConfig.safety, readOnly: true },
};

const DEVICE_VALUE = {
    innerWidth      : 412,
    innerHeight     : 915,
    devicePixelRatio: 2.625,
    userAgent       : "Mozilla/5.0 (Linux; Android 14; Pixel 7)",
    maxTouchPoints  : 5,
};

const BROWSER_VERSION = {
    protocolVersion: "1.3",
    product        : "Chrome/131.0.6778.86",
    revision       : "@0123456789abcdef",
    userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    jsVersion: "13.1.201.15",
};

const MEDIA_VALUE = {
    colorScheme  : "dark",
    reducedMotion: "no-preference",
    contrast     : "no-preference",
    forcedColors : "none",
    mediaPrint   : true,
};

const LOCALE_VALUE = {
    language : "de-DE",
    timezone : "Europe/Berlin",
    formatted: "1.6.2026, 14:00:00",
};

function emulationFake(): FakeAccess {
    const fake = new FakeAccess();

    fake.respond = (_targetId, method, params) => {
        if (method === "Browser.getVersion") return BROWSER_VERSION;

        if (method !== "Runtime.evaluate") return {};

        const expression = (params as { expression?: unknown })?.expression;

        if (expression === DEVICE_READ_EXPRESSION) {
            return { result: { type: "object", value: DEVICE_VALUE } };
        }

        if (expression === MEDIA_READ_EXPRESSION) {
            return { result: { type: "object", value: MEDIA_VALUE } };
        }

        if (expression === LOCALE_READ_EXPRESSION) {
            return { result: { type: "object", value: LOCALE_VALUE } };
        }

        return { result: { type: "undefined" } };
    };

    return fake;
}

function setup(fake: FakeAccess = emulationFake(), config: Config = managedConfig) {
    const runtime = new ToolRuntime({ access: fake.asAccess(), config });

    return { fake, runtime };
}

async function openTab(runtime: ToolRuntime) {
    const result = await runTool(newTab, {}, extra(), runtime);

    expect(result.isError).not.toBe(true);
}

function methods(fake: FakeAccess): string[] {
    return fake.sent.map((entry) => entry.method);
}

describe("list_devices", () => {
    it("lists the table with landscape sizes", async () => {
        const { runtime } = setup();
        const result = await runTool(listDevices, {}, extra(), runtime);
        const structured = result.structuredContent as {
            devices: Array<{ name: string; landscape: { width: number; height: number } }>;
            total  : number;
        };

        expect(result.isError).not.toBe(true);
        expect(structured.total).toBe(structured.devices.length);
        expect(structured.total).toBeGreaterThanOrEqual(15);

        const phone = structured.devices.find((device) => device.name === "iPhone 14");

        expect(phone?.landscape).toEqual({ width: 844, height: 390 });
    });

    it("filters by query and kind", async () => {
        const { runtime } = setup();

        const phones = await runTool(listDevices, { kind: "phone" }, extra(), runtime);
        const structured = phones.structuredContent as {
            devices: Array<{ kind: string }>;
            total  : number;
        };

        expect(structured.devices.every((device) => device.kind === "phone")).toBe(true);

        const pixel = await runTool(listDevices, { query: "pixel 7" }, extra(), runtime);
        const found = pixel.structuredContent as {
            devices: Array<{ name: string }>;
            total  : number;
        };

        expect(found.devices.map((device) => device.name)).toEqual(["Pixel 7"]);
    });

    it("is a read tool that works in read-only mode", async () => {
        expect(listDevices.access).toBe("read");

        const { runtime } = setup(emulationFake(), readOnly);
        const result = await runTool(listDevices, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
    });
});

describe("emulate_device", () => {
    it("applies a phone and reads back the page values", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        fake.sent.length = 0;

        const result = await runTool(emulateDevice, { device: "pixel 7" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            tab      : "tab1",
            emulation: {
                device: {
                    name             : "Pixel 7",
                    width            : 412,
                    height           : 915,
                    deviceScaleFactor: 2.625,
                    mobile           : true,
                    touch            : true,
                    landscape        : false,
                },
            },
            reported: DEVICE_VALUE,
        });
        expect(methods(fake)).toEqual([
            "Browser.getVersion",
            "Emulation.setDeviceMetricsOverride",
            "Emulation.setTouchEmulationEnabled",
            "Emulation.setEmitTouchEventsForMouse",
            "Emulation.setUserAgentOverride",
            "Runtime.evaluate",
        ]);
        expect(fake.sent[1]?.params).toMatchObject({ mobile: true });
        expect(fake.sent[4]?.params).toMatchObject({
            userAgent: expect.stringContaining("Pixel 7") as string,
        });
    });

    it("sends the Chrome major of the connected browser in a device user agent", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        fake.sent.length = 0;

        await runTool(emulateDevice, { device: "pixel 7" }, extra(), runtime);

        const params = fake.sent.find((call) => call.method === "Emulation.setUserAgentOverride")?.params;

        expect(params?.userAgent).toContain("Chrome/131.0.0.0 Mobile Safari/537.36");
        expect(params?.userAgent).not.toContain("Chrome/124");
    });

    it("keeps the table user agent when the browser version is unavailable", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        fake.failSend = (_targetId, method) =>
            method === "Browser.getVersion" ? new Error("no browser domain") : undefined;
        fake.sent.length = 0;

        const result = await runTool(emulateDevice, { device: "pixel 7" }, extra(), runtime);
        const params = fake.sent.find((call) => call.method === "Emulation.setUserAgentOverride")?.params;

        expect(result.isError).not.toBe(true);
        expect(params?.userAgent).toContain("Chrome/124.0.0.0 Mobile Safari/537.36");
    });

    it("leaves iOS Safari user agents and explicit user agents untouched", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        fake.sent.length = 0;

        await runTool(emulateDevice, { device: "iphone 14" }, extra(), runtime);
        await runTool(emulateDevice, {
            width            : 800,
            height           : 600,
            deviceScaleFactor: 1,
            mobile           : false,
            touch            : false,
            userAgent        : "Custom Chrome/99.0.0.0",
        }, extra(), runtime);

        const agents = fake.sent
            .filter((call) => call.method === "Emulation.setUserAgentOverride")
            .map((call) => call.params?.userAgent);

        expect(agents[0]).toContain("iPhone OS 18_6");
        expect(agents[0]).toContain("Version/18.6");
        expect(agents[1]).toBe("Custom Chrome/99.0.0.0");
        expect(methods(fake).filter((method) => method === "Browser.getVersion")).toHaveLength(1);
    });

    it("applies explicit values with landscape and omits the announced metadata", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        fake.sent.length = 0;

        const result = await runTool(emulateDevice, {
            width            : 800,
            height           : 600,
            deviceScaleFactor: 2,
            mobile           : false,
            touch            : true,
            landscape        : true,
        }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            emulation: {
                device: { name: "Custom", width: 600, height: 800, landscape: true, touch: true },
            },
        });
        expect(fake.sent[0]?.params).toMatchObject({
            width            : 600,
            height           : 800,
            screenOrientation: { type: "landscapePrimary", angle: 90 },
        });
        expect(fake.sent[3]?.params).toEqual({ userAgent: "" });
        expect(emulateDevice.description).toContain("Client hints metadata is not emulated");
    });

    it("resets the device overrides but keeps the accept language of the locale", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        await runTool(emulateLocale, { acceptLanguage: "de-DE" }, extra(), runtime);
        await runTool(emulateDevice, { device: "Pixel 7" }, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(emulateDevice, { reset: true }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            emulation: { locale: { acceptLanguage: "de-DE" } },
        });
        expect((result.structuredContent as { emulation: object }).emulation).not.toHaveProperty("device");
        expect(methods(fake)).toEqual([
            "Emulation.setUserAgentOverride",
            "Emulation.clearDeviceMetricsOverride",
            "Emulation.setEmitTouchEventsForMouse",
            "Emulation.setTouchEmulationEnabled",
            "Runtime.evaluate",
        ]);
        expect(fake.sent[0]?.params).toEqual({ userAgent: "", acceptLanguage: "de-DE" });
    });

    it("suggests close names for an unknown device", async () => {
        const { runtime } = setup();

        await openTab(runtime);

        const result = await runTool(emulateDevice, { device: "iPhon 14" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("iPhone 14");
    });

    it("names new_tab when no tab is selected and maps daemon errors", async () => {
        const { runtime } = setup();
        const missing = await runTool(emulateDevice, { device: "Pixel 7" }, extra(), runtime);

        expect(missing.isError).toBe(true);
        expect(JSON.stringify(missing.content)).toContain("new_tab");

        const fake = emulationFake();

        fake.failSend = () => new RpcError(ErrorCode.notFound, "The tab was closed.");
        const failing = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

        await runTool(newTab, {}, extra(), failing);

        const result = await runTool(emulateDevice, { device: "Pixel 7" }, extra(), failing);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("Call list_tabs");
    });
});

describe("emulate_media", () => {
    it("applies features and keeps them merged across calls", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        fake.sent.length = 0;

        const first = await runTool(
            emulateMedia,
            { media: "print", colorScheme: "dark" },
            extra(),
            runtime,
        );

        expect(first.isError).not.toBe(true);
        expect(first.structuredContent).toMatchObject({
            emulation: { media: { media: "print", colorScheme: "dark" } },
            reported : MEDIA_VALUE,
        });
        expect(methods(fake)).toEqual(["Emulation.setEmulatedMedia", "Runtime.evaluate"]);

        fake.sent.length = 0;

        const second = await runTool(emulateMedia, { reducedMotion: "reduce" }, extra(), runtime);

        expect(second.isError).not.toBe(true);
        expect(second.structuredContent).toMatchObject({
            emulation: { media: { media: "print", colorScheme: "dark", reducedMotion: "reduce" } },
        });

        const params = fake.sent[0]?.params as {
            features?: Array<{ name: string; value: string }>;
        };

        expect(params?.features).toContainEqual({ name: "prefers-color-scheme", value: "dark" });
        expect(params?.features).toContainEqual({ name: "prefers-reduced-motion", value: "reduce" });
    });

    it("resets every media override at once", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        await runTool(emulateMedia, { colorScheme: "dark" }, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(emulateMedia, { reset: true }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect((result.structuredContent as { emulation: object }).emulation).not.toHaveProperty("media");
        expect(fake.sent[0]).toMatchObject({
            method: "Emulation.setEmulatedMedia",
            params: { media: "", features: [] },
        });
    });

    it("rejects an empty call and a missing tab", async () => {
        const { runtime } = setup();
        const missing = await runTool(emulateMedia, { colorScheme: "dark" }, extra(), runtime);

        expect(missing.isError).toBe(true);
        expect(JSON.stringify(missing.content)).toContain("new_tab");

        await openTab(runtime);

        const empty = await runTool(emulateMedia, {}, extra(), runtime);

        expect(empty.isError).toBe(true);
        expect(JSON.stringify(empty.content)).toContain("at least one media field");
    });
});

describe("emulate_network", () => {
    it("applies a preset through the capture manager Network.enable", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        fake.sent.length = 0;

        const result = await runTool(emulateNetwork, { preset: "slow-3g" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            emulation: {
                network: {
                    preset      : "slow-3g",
                    offline     : false,
                    latencyMs   : 2000,
                    downloadKbps: 400,
                    uploadKbps  : 400,
                    blockUrls   : [],
                },
            },
        });
        expect(methods(fake)).toEqual([
            "Network.enable",
            "Network.emulateNetworkConditions",
            "Network.setBlockedURLs",
        ]);
        expect(fake.sent[1]?.params).toMatchObject({
            offline           : false,
            latency           : 2000,
            downloadThroughput: 50000,
            uploadThroughput  : 50000,
        });
        expect(fake.subscribed.filter((entry) => entry.event.startsWith("Network."))).toHaveLength(6);
    });

    it("shares Network.enable with network_requests without disabling capture", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        await runTool(emulateNetwork, { preset: "offline" }, extra(), runtime);
        await runTool(listTabs, { scope: "owned" }, extra(), runtime);

        const enabled = methods(fake).filter((method) => method === "Network.enable");

        expect(enabled).toHaveLength(1);
        expect(runtime.capture.networkEnabled("tab1")).toBe(true);
        expect(fake.unsubscribed).toEqual([]);
        expect(methods(fake)).not.toContain("Network.disable");

        await runTool(emulateNetwork, { reset: true }, extra(), runtime);

        expect(runtime.capture.networkEnabled("tab1")).toBe(true);
        expect(methods(fake)).not.toContain("Network.disable");
        expect(methods(fake).filter((method) => method === "Network.enable")).toHaveLength(1);
    });

    it("merges blockUrls and keeps the preset name", async () => {
        const { runtime } = setup();

        await openTab(runtime);
        await runTool(emulateNetwork, { preset: "4g" }, extra(), runtime);

        const result = await runTool(emulateNetwork, { blockUrls: ["*/ping"] }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            emulation: { network: { preset: "4g", blockUrls: ["*/ping"] } },
        });
    });

    it("rejects a reset mixed with other fields and a missing tab", async () => {
        const { runtime } = setup();
        const missing = await runTool(emulateNetwork, { preset: "4g" }, extra(), runtime);

        expect(missing.isError).toBe(true);
        expect(JSON.stringify(missing.content)).toContain("new_tab");

        await openTab(runtime);

        const mixed = await runTool(emulateNetwork, { preset: "4g", latencyMs: 5 }, extra(), runtime);

        expect(mixed.isError).toBe(true);
        expect(JSON.stringify(mixed.content)).toContain("either preset or the custom");
    });
});

describe("emulate_locale", () => {
    it("applies locale, timezone and accept language and reads them back", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        fake.sent.length = 0;

        const result = await runTool(emulateLocale, {
            locale        : "de-de",
            timezone      : "Europe/Berlin",
            acceptLanguage: "de-DE,de;q=0.9",
        }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            emulation: {
                locale: {
                    locale        : "de-DE",
                    timezone      : "Europe/Berlin",
                    acceptLanguage: "de-DE,de;q=0.9",
                },
            },
            reported: LOCALE_VALUE,
        });
        expect(methods(fake)).toEqual([
            "Emulation.setLocaleOverride",
            "Emulation.setTimezoneOverride",
            "Emulation.setUserAgentOverride",
            "Runtime.evaluate",
        ]);
        expect(fake.sent[2]?.params).toEqual({ userAgent: "", acceptLanguage: "de-DE,de;q=0.9" });
    });

    it("merges a later timezone over the previous locale", async () => {
        const { runtime } = setup();

        await openTab(runtime);
        await runTool(emulateLocale, { locale: "de-DE" }, extra(), runtime);

        const result = await runTool(emulateLocale, { timezone: "Asia/Tokyo" }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({
            emulation: { locale: { locale: "de-DE", timezone: "Asia/Tokyo" } },
        });
    });

    it("keeps the device user agent when the locale resets", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        await runTool(emulateDevice, { device: "Pixel 7" }, extra(), runtime);
        await runTool(emulateLocale, { acceptLanguage: "de-DE" }, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(emulateLocale, { reset: true }, extra(), runtime);

        expect(result.isError).not.toBe(true);

        const agents = fake.sent.filter((entry) => entry.method === "Emulation.setUserAgentOverride");

        expect(agents).toHaveLength(1);
        expect(agents[0]?.params).toMatchObject({ userAgent: expect.stringContaining("Pixel 7") as string });
        expect(agents[0]?.params).not.toHaveProperty("acceptLanguage");
    });

    it("does not pin the real user agent when the device has none of its own", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        const applied = await runTool(emulateDevice, {
            width            : 600,
            height           : 800,
            deviceScaleFactor: 2,
            mobile           : false,
            touch            : false,
        }, extra(), runtime);

        expect(applied.isError).not.toBe(true);
        await runTool(emulateLocale, { acceptLanguage: "de-DE" }, extra(), runtime);
        fake.sent.length = 0;

        await runTool(emulateLocale, { reset: true }, extra(), runtime);

        const agents = fake.sent.filter((entry) => entry.method === "Emulation.setUserAgentOverride");

        expect(agents).toHaveLength(1);
        expect(agents[0]?.params).toEqual({ userAgent: "" });
    });

    it("validates every field and names new_tab without a tab", async () => {
        const { runtime } = setup();
        const missing = await runTool(emulateLocale, { locale: "de-DE" }, extra(), runtime);

        expect(missing.isError).toBe(true);
        expect(JSON.stringify(missing.content)).toContain("new_tab");

        await openTab(runtime);

        const badLocale = await runTool(emulateLocale, { locale: "not a locale !!!" }, extra(), runtime);

        expect(badLocale.isError).toBe(true);
        expect(JSON.stringify(badLocale.content)).toContain("BCP 47");

        const badZone = await runTool(emulateLocale, { timezone: "Mars/Olympus" }, extra(), runtime);

        expect(badZone.isError).toBe(true);
        expect(JSON.stringify(badZone.content)).toContain("IANA");

        const badHeader = await runTool(emulateLocale, { acceptLanguage: "de\nx" }, extra(), runtime);

        expect(badHeader.isError).toBe(true);
        expect(JSON.stringify(badHeader.content)).toContain("printable ASCII");
    });
});

describe("emulation tools", () => {
    it("marks the four emulation tools as mutate and refuses them in read-only mode", async () => {
        expect(emulateDevice.access).toBe("mutate");
        expect(emulateMedia.access).toBe("mutate");
        expect(emulateNetwork.access).toBe("mutate");
        expect(emulateLocale.access).toBe("mutate");

        const { runtime } = setup(emulationFake(), readOnly);

        for (
            const [tool, args] of [
                [emulateDevice, { device: "Pixel 7" }],
                [emulateMedia, { colorScheme: "dark" }],
                [emulateNetwork, { preset: "4g" }],
                [emulateLocale, { locale: "de-DE" }],
            ] as const
        ) {
            const result = await runTool(tool, args, extra(), runtime);

            expect(result.isError).toBe(true);
            expect(JSON.stringify(result.content)).toContain("read-only mode");
        }
    });

    it("never sends a focus stealing call", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        await runTool(emulateDevice, { device: "Pixel 7" }, extra(), runtime);
        await runTool(emulateMedia, { colorScheme: "dark" }, extra(), runtime);
        await runTool(emulateNetwork, { preset: "4g" }, extra(), runtime);
        await runTool(emulateLocale, { locale: "de-DE" }, extra(), runtime);

        expect(methods(fake)).not.toContain("Page.bringToFront");
        expect(methods(fake)).not.toContain("Target.activateTarget");
    });

    it("exposes the state through page_info", async () => {
        const { runtime } = setup();

        await openTab(runtime);
        await runTool(emulateDevice, { device: "Pixel 7" }, extra(), runtime);

        const result = await runTool(pageInfo, {}, extra(), runtime);

        expect(result.structuredContent).toMatchObject({
            emulation: { device: { name: "Pixel 7" } },
        });
    });

    it("clears the tab state when the tab closes", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        await runTool(emulateDevice, { device: "Pixel 7" }, extra(), runtime);
        runtime.emulation.forget("tab1");
        fake.emit("tab.closed", { targetId: "tab1" });

        expect(runtime.emulation.snapshot("tab1")).toEqual({
            device : undefined,
            media  : undefined,
            network: undefined,
            locale : undefined,
        });
    });

    it("forgets the tab on the daemon tab.closed event once wired", async () => {
        const { fake, runtime } = setup();

        fake.on("tab.closed", (params) => {
            const targetId = (params as { targetId?: unknown })?.targetId;

            if (typeof targetId === "string") runtime.emulation.forget(targetId);
        });

        await openTab(runtime);
        await runTool(emulateDevice, { device: "Pixel 7" }, extra(), runtime);
        fake.emit("tab.closed", { targetId: "tab1" });

        expect(runtime.emulation.snapshot("tab1").device).toBeUndefined();
    });
});

describe("emulation rollback", () => {
    it("restores the connection when blocking urls fails after the conditions were sent", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        fake.failSend = (_tab, method) =>
            method === "Network.setBlockedURLs"
                ? new RpcError(ErrorCode.cdpError, "blocked patterns rejected")
                : undefined;
        fake.sent.length = 0;

        const result = await runTool(
            emulateNetwork,
            { preset: "offline", blockUrls: ["*/ads"] },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(runtime.emulation.snapshot("tab1").network).toBeUndefined();

        const conditions = fake.sent.filter((entry) => entry.method === "Network.emulateNetworkConditions");

        expect(conditions).toHaveLength(2);
        expect(conditions[1]?.params).toMatchObject({ offline: false, latency: 0 });
    });

    it("restores the previous network state when a later send fails", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        await runTool(emulateNetwork, { preset: "4g" }, extra(), runtime);

        fake.failSend = (_tab, method) =>
            method === "Network.setBlockedURLs"
                ? new RpcError(ErrorCode.cdpError, "blocked patterns rejected")
                : undefined;

        const result = await runTool(
            emulateNetwork,
            { preset: "offline", blockUrls: ["*/ads"] },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(runtime.emulation.snapshot("tab1").network).toMatchObject({
            preset   : "4g",
            offline  : false,
            latencyMs: 170,
        });
    });

    it("undoes the network conditions when the call is cancelled between sends", async () => {
        const { fake, runtime } = setup();
        const controller = new AbortController();

        await openTab(runtime);

        fake.respond = (_tab, method) => {
            if (method === "Network.emulateNetworkConditions") controller.abort();

            return {};
        };

        fake.sent.length = 0;

        const result = await runTool(
            emulateNetwork,
            { preset: "offline" },
            { signal: controller.signal } as Extra,
            runtime,
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(result.isError).toBe(true);
        expect(runtime.emulation.snapshot("tab1").network).toBeUndefined();
        expect(fake.sent.at(-1)?.method).toBe("Network.emulateNetworkConditions");
        expect(fake.sent.at(-1)?.params).toMatchObject({ offline: false });
        expect(methods(fake)).not.toContain("Network.setBlockedURLs");
    });

    it("clears the device metrics when the user agent send fails", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        fake.failSend = (_tab, method) =>
            method === "Emulation.setUserAgentOverride"
                ? new RpcError(ErrorCode.cdpError, "user agent rejected")
                : undefined;
        fake.sent.length = 0;

        const result = await runTool(emulateDevice, { device: "Pixel 7" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(runtime.emulation.snapshot("tab1").device).toBeUndefined();
        expect(methods(fake)).toContain("Emulation.clearDeviceMetricsOverride");
    });

    it("records the device before the read so a failing read keeps the applied state", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        fake.failSend = (_tab, method) =>
            method === "Runtime.evaluate"
                ? new RpcError(ErrorCode.cdpError, "evaluate failed")
                : undefined;

        const result = await runTool(emulateDevice, { device: "Pixel 7" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(runtime.emulation.snapshot("tab1").device?.name).toBe("Pixel 7");
    });

    it("rethrows a cancellation during a read and still swallows other read failures", async () => {
        const fake = emulationFake();
        const signal = new AbortController().signal;

        fake.failSend = () => new IpcCancelledError("cdp.send");
        await expect(readMedia(fake.asAccess(), "tab1", signal)).rejects.toBeInstanceOf(IpcCancelledError);

        fake.failSend = () => new RpcError(ErrorCode.cdpError, "evaluate failed");
        await expect(readMedia(fake.asAccess(), "tab1", signal)).resolves.toBeUndefined();
    });

    it("undoes media and locale when a later send fails", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        fake.failSend = (_tab, method) =>
            method === "Emulation.setTimezoneOverride"
                ? new RpcError(ErrorCode.cdpError, "timezone rejected")
                : undefined;
        fake.sent.length = 0;

        const result = await runTool(
            emulateLocale,
            { locale: "de-DE", timezone: "Europe/Berlin" },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(runtime.emulation.snapshot("tab1").locale).toBeUndefined();
        expect(fake.sent.filter((entry) => entry.method === "Emulation.setLocaleOverride")).toHaveLength(2);
    });
});

describe("emulation input checks", () => {
    it("clears blocked urls with the none preset", async () => {
        const { runtime } = setup();

        await openTab(runtime);
        await runTool(emulateNetwork, { preset: "4g", blockUrls: ["*/ads"] }, extra(), runtime);

        const result = await runTool(emulateNetwork, { preset: "none" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(runtime.emulation.snapshot("tab1").network?.blockUrls).toEqual([]);
    });

    it("rejects a zero throughput", async () => {
        const { runtime } = setup();

        await openTab(runtime);

        const result = await runTool(emulateNetwork, { downloadKbps: 0 }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("stalls");
    });

    it("rejects a reset mixed with other media or locale fields", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        fake.sent.length = 0;

        const media = await runTool(emulateMedia, { reset: true, colorScheme: "dark" }, extra(), runtime);
        const locale = await runTool(emulateLocale, { reset: true, locale: "de-DE" }, extra(), runtime);

        expect(media.isError).toBe(true);
        expect(locale.isError).toBe(true);
        expect(fake.sent).toEqual([]);
    });

    it("resets locale and timezone without any recorded state", async () => {
        const { fake, runtime } = setup();

        await openTab(runtime);
        fake.sent.length = 0;

        const result = await runTool(emulateLocale, { reset: true }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(methods(fake)).toContain("Emulation.setLocaleOverride");
        expect(methods(fake)).toContain("Emulation.setTimezoneOverride");
    });
});
