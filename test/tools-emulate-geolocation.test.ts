import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import { emulateGeolocation, runTool, ToolRuntime } from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const SITE = "https://a.example";
const OTHER = "https://b.example";

function tab(targetId: string, url: string) {
    return { targetId, url, title: "t", owned: true, created: true };
}

function setup(config: Config = managedConfig) {
    const fake = new FakeAccess({
        tabs: [tab("tab1", `${SITE}/page`), tab("tab2", `${SITE}/other`), tab("blank", "about:blank")],
    });

    fake.respond = (_tab, method, params) => {
        if (method === "Runtime.evaluate") {
            const expression = String((params as { expression?: unknown }).expression);

            if (expression.includes("getCurrentPosition")) {
                return {
                    result: {
                        type : "object",
                        value: { ok: true, latitude: 52.52, longitude: 13.405, accuracy: 10 },
                    },
                };
            }
        }

        return {};
    };

    const runtime = new ToolRuntime({ access: fake.asAccess(), config });

    runtime.tabs.select("tab1");

    return { fake, runtime };
}

const overrides = (fake: FakeAccess) =>
    fake.sent
        .filter((call) => call.method === "Emulation.setGeolocationOverride")
        .map((call) => call.params);

const text = (result: { content: unknown }) => JSON.stringify(result.content);

describe("emulate_geolocation", () => {
    it("allows the origin of the tab, sets the position and reports what the page reads", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(
            emulateGeolocation,
            { latitude: 52.52, longitude: 13.405, accuracy: 25 },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(fake.permissions).toEqual([{ name: "geolocation", setting: "granted", origin: SITE }]);
        expect(overrides(fake)).toEqual([{ latitude: 52.52, longitude: 13.405, accuracy: 25 }]);
        expect(result.structuredContent).toMatchObject({
            tab      : "tab1",
            emulation: {
                geolocation: { latitude: 52.52, longitude: 13.405, accuracy: 25, origin: SITE },
            },
            reported: { ok: true, latitude: 52.52 },
        });
        expect(fake.order.indexOf("permission granted")).toBeLessThan(
            fake.order.indexOf("send Emulation.setGeolocationOverride"),
        );
    });

    it("defaults the accuracy and takes an explicit origin for a tab without a page", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(
            emulateGeolocation,
            { tab: "blank", latitude: 1, longitude: 2, origin: OTHER },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(fake.permissions[0]).toMatchObject({ origin: OTHER });
        expect(overrides(fake)).toEqual([{ latitude: 1, longitude: 2, accuracy: 10 }]);
    });

    it("keeps focus emulation on so a background tab receives positions", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);

        expect(fake.sent.map((call) => call.method)).toContain("Emulation.setFocusEmulationEnabled");
    });

    it("asks for an origin when the tab shows no web page", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(
            emulateGeolocation,
            { tab: "blank", latitude: 1, longitude: 2 },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("Pass origin");
        expect(fake.permissions).toEqual([]);
    });

    it.each(["example.com", "ftp://example.com", "https://example.com/path", "javascript:1"])(
        "rejects the malformed origin %s",
        async (origin) => {
            const { fake, runtime } = setup();
            const result = await runTool(
                emulateGeolocation,
                { latitude: 1, longitude: 2, origin },
                extra(),
                runtime,
            );

            expect(result.isError).toBe(true);
            expect(text(result)).toContain("http or https origin");
            expect(fake.permissions).toEqual([]);
        },
    );

    it("needs both coordinates or reset, and reset takes nothing else", async () => {
        const { fake, runtime } = setup();
        const missing = await runTool(emulateGeolocation, { latitude: 1 }, extra(), runtime);
        const mixed = await runTool(
            emulateGeolocation,
            { reset: true, latitude: 1, longitude: 2 },
            extra(),
            runtime,
        );

        expect(text(missing)).toContain("latitude and longitude");
        expect(text(mixed)).toContain("reset: true takes no other");
        expect(fake.sent).toEqual([]);
    });

    it("removes the override and the permission on reset", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);
        const result = await runTool(emulateGeolocation, { reset: true }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ emulation: {} });
        expect(result.structuredContent).not.toHaveProperty("emulation.geolocation");
        expect(overrides(fake).at(-1)).toEqual({});
        expect(fake.permissions.at(-1)).toEqual({ name: "geolocation", setting: "reset", origin: SITE });
    });

    it("can retry a permission reset that the browser rejected", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);
        fake.failPermission = new Error("reset failed");
        const failed = await runTool(emulateGeolocation, { reset: true }, extra(), runtime);

        expect(failed.isError).toBe(true);
        fake.failPermission = undefined;
        const retried = await runTool(emulateGeolocation, { reset: true }, extra(), runtime);

        expect(retried.isError).not.toBe(true);
        expect(fake.permissions.at(-1)).toEqual({ name: "geolocation", setting: "reset", origin: SITE });
    });

    it("restores the permission when resetting the browser emulation fails", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);
        fake.failSend = (_tab, method) => method === "Emulation.setGeolocationOverride"
            ? new Error("reset failed") : undefined;
        const result = await runTool(emulateGeolocation, { reset: true }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(fake.permissions.at(-1)).toEqual({ name: "geolocation", setting: "granted", origin: SITE });
        expect(runtime.emulation.snapshot("tab1").geolocation?.origin).toBe(SITE);
    });

    it("reports when a failed reset cannot restore the previous permission", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);
        const original = fake.setPermission.bind(fake);

        fake.setPermission = async (request) => {
            if (request.setting === "granted") throw new Error("grant failed");

            await original(request);
        };

        fake.failSend = (_tab, method) => method === "Emulation.setGeolocationOverride"
            ? new Error("reset failed") : undefined;
        const result = await runTool(emulateGeolocation, { reset: true }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("previous permission could not be restored");
    });

    it("restores the permission when reset is cancelled while releasing it", async () => {
        const { fake, runtime } = setup();
        const controller = new AbortController();
        let unblock: () => void = () => undefined;
        let started: () => void = () => undefined;
        const entered = new Promise<void>((resolve) => { started = resolve; });
        const gate = new Promise<void>((resolve) => { unblock = resolve; });

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);
        const original = fake.setPermission.bind(fake);

        fake.setPermission = async (request) => {
            if (request.setting === "reset") {
                started();
                await gate;
            }

            await original(request);
        };

        const call = runTool(emulateGeolocation, { reset: true },
            { signal: controller.signal } as Extra, runtime);

        await entered;
        controller.abort();
        unblock();
        await call;
        await runtime.emulation.withGeolocation(async () => undefined);

        expect(fake.permissions.at(-1)).toEqual({ name: "geolocation", setting: "granted", origin: SITE });
        expect(runtime.emulation.snapshot("tab1").geolocation?.origin).toBe(SITE);
    });

    it("keeps the permission while another tab still uses the origin", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);
        await runTool(emulateGeolocation, { tab: "tab2", latitude: 3, longitude: 4 }, extra(), runtime);
        await runTool(emulateGeolocation, { reset: true }, extra(), runtime);

        expect(fake.permissions.some((entry) => entry.setting === "reset")).toBe(false);

        await runTool(emulateGeolocation, { tab: "tab2", reset: true }, extra(), runtime);

        expect(fake.permissions.at(-1)).toEqual({ name: "geolocation", setting: "reset", origin: SITE });
    });

    it("releases the permission when two tabs reset at the same time", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);
        await runTool(emulateGeolocation, { tab: "tab2", latitude: 3, longitude: 4 }, extra(), runtime);
        const results = await Promise.all([
            runTool(emulateGeolocation, { reset: true }, extra(), runtime),
            runTool(emulateGeolocation, { tab: "tab2", reset: true }, extra(), runtime),
        ]);

        expect(results.every((result) => result.isError !== true)).toBe(true);
        expect(fake.permissions.at(-1)).toEqual({ name: "geolocation", setting: "reset", origin: SITE });
    });

    it("releases the old permission when two tabs switch origins at the same time", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);
        await runTool(emulateGeolocation, { tab: "tab2", latitude: 3, longitude: 4 }, extra(), runtime);
        const results = await Promise.all([
            runTool(
                emulateGeolocation, { latitude: 1, longitude: 2, origin: OTHER }, extra(), runtime,
            ),
            runTool(emulateGeolocation, {
                tab: "tab2", latitude: 3, longitude: 4, origin: "https://c.example",
            }, extra(), runtime),
        ]);

        expect(results.every((result) => result.isError !== true)).toBe(true);
        expect(fake.permissions).toContainEqual({ name: "geolocation", setting: "reset", origin: SITE });
    });

    it("releases the permission when one tab closes while another resets", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);
        await runTool(emulateGeolocation, { tab: "tab2", latitude: 3, longitude: 4 }, extra(), runtime);
        await Promise.all([
            runtime.forgetTab("tab1"),
            runTool(emulateGeolocation, { tab: "tab2", reset: true }, extra(), runtime),
        ]);

        expect(fake.permissions.at(-1)).toEqual({ name: "geolocation", setting: "reset", origin: SITE });
    });

    it("retries a failed permission cleanup after the tab closes", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);
        fake.failPermission = new Error("reset failed");
        await runtime.forgetTab("tab1");
        fake.failPermission = undefined;
        await runTool(emulateGeolocation, {
            tab: "tab2", latitude: 3, longitude: 4, origin: OTHER,
        }, extra(), runtime);

        expect(fake.permissions.slice(-2)).toEqual([
            { name: "geolocation", setting: "reset", origin: SITE },
            { name: "geolocation", setting: "granted", origin: OTHER },
        ]);
    });

    it("does not grant another origin while an earlier cleanup still fails", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);
        fake.failPermission = new Error("reset failed");
        await runtime.forgetTab("tab1");
        const result = await runTool(emulateGeolocation, {
            tab: "tab2", latitude: 3, longitude: 4, origin: OTHER,
        }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("previous geolocation permission");
        expect(fake.permissions.some((entry) => entry.origin === OTHER)).toBe(false);
    });

    it("moves the permission when the same tab is given another origin", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);
        await runTool(
            emulateGeolocation,
            { latitude: 3, longitude: 4, origin: OTHER },
            extra(),
            runtime,
        );

        expect(fake.permissions.map((entry) => `${entry.setting} ${entry.origin}`)).toEqual([
            `granted ${SITE}`,
            `reset ${SITE}`,
            `granted ${OTHER}`,
        ]);
    });

    it("does not switch origins if releasing the previous permission fails", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);
        const original = fake.setPermission.bind(fake);

        fake.setPermission = async (request) => {
            if (request.setting === "reset" && request.origin === SITE) throw new Error("reset failed");

            await original(request);
        };

        const result = await runTool(
            emulateGeolocation, { latitude: 3, longitude: 4, origin: OTHER }, extra(), runtime,
        );

        expect(result.isError).toBe(true);
        expect(runtime.emulation.snapshot("tab1").geolocation?.origin).toBe(SITE);
        expect(fake.permissions.some((entry) => entry.origin === OTHER)).toBe(false);
    });

    it("does not grant a new origin after cancellation during the previous reset", async () => {
        const { fake, runtime } = setup();
        const controller = new AbortController();
        let unblock: () => void = () => undefined;
        let started: () => void = () => undefined;
        const entered = new Promise<void>((resolve) => { started = resolve; });
        const gate = new Promise<void>((resolve) => { unblock = resolve; });

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);
        const original = fake.setPermission.bind(fake);

        fake.setPermission = async (request) => {
            if (request.setting === "reset") {
                started();
                await gate;
            }

            await original(request);
        };

        const call = runTool(emulateGeolocation, {
            latitude: 3, longitude: 4, origin: OTHER,
        }, { signal: controller.signal } as Extra, runtime);

        await entered;
        controller.abort();
        unblock();
        await call;
        await runtime.emulation.withGeolocation(async () => undefined);

        expect(fake.permissions).not.toContainEqual({
            name: "geolocation", setting: "granted", origin: OTHER,
        });
        expect(fake.permissions.at(-1)).toEqual({ name: "geolocation", setting: "granted", origin: SITE });
    });

    it("warns when the new permission cannot be cleaned up after an emulation failure", async () => {
        const { fake, runtime } = setup();
        const original = fake.setPermission.bind(fake);

        fake.setPermission = async (request) => {
            if (request.setting === "reset") throw new Error("reset failed");

            await original(request);
        };

        fake.failSend = (_tab, method) =>
            method === "Emulation.setGeolocationOverride" ? new Error("emulation failed") : undefined;
        const result = await runTool(
            emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime,
        );

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("session");
        expect(text(result)).toContain("permission");
    });

    it("restores the old permission if granting the new origin fails", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);
        const original = fake.setPermission.bind(fake);

        fake.setPermission = async (request) => {
            if (request.origin === OTHER && request.setting === "granted") throw new Error("grant failed");

            await original(request);
        };

        const result = await runTool(
            emulateGeolocation, { latitude: 3, longitude: 4, origin: OTHER }, extra(), runtime,
        );

        expect(result.isError).toBe(true);
        expect(runtime.emulation.snapshot("tab1").geolocation?.origin).toBe(SITE);
        expect(fake.permissions.at(-1)).toEqual({ name: "geolocation", setting: "granted", origin: SITE });
    });

    it("releases the permission when the tab is forgotten", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateGeolocation, { latitude: 1, longitude: 2 }, extra(), runtime);
        await runtime.forgetTab("tab1");

        expect(fake.permissions.at(-1)).toEqual({ name: "geolocation", setting: "reset", origin: SITE });
    });

    it("undoes the permission when the override cannot be applied", async () => {
        const { fake, runtime } = setup();

        fake.failSend = (_tab, method) =>
            method === "Emulation.setGeolocationOverride" ? new Error("browser went away") : undefined;

        const result = await runTool(
            emulateGeolocation,
            { latitude: 1, longitude: 2 },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(fake.permissions.at(-1)).toEqual({ name: "geolocation", setting: "reset", origin: SITE });
        expect(runtime.emulation.snapshot("tab1").geolocation).toBeUndefined();
    });

    it("reports a refusal of the daemon and changes nothing", async () => {
        const { fake, runtime } = setup();

        fake.failPermission = new RpcError(
            ErrorCode.forbiddenMethod,
            "permission.set would act for b.example, which is outside safety.allowedDomains.",
        );

        const result = await runTool(
            emulateGeolocation,
            { latitude: 1, longitude: 2 },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("allowedDomains");
        expect(overrides(fake)).toEqual([]);
    });
});

describe("emulate_geolocation input schema", () => {
    const accepts = (value: unknown) => emulateGeolocation.input.safeParse(value).success;

    it("limits the coordinates and the accuracy", () => {
        expect(accepts({ latitude: 90, longitude: -180, accuracy: 0 })).toBe(true);
        expect(accepts({ latitude: 91, longitude: 0 })).toBe(false);
        expect(accepts({ latitude: 0, longitude: 181 })).toBe(false);
        expect(accepts({ latitude: 0, longitude: 0, accuracy: -1 })).toBe(false);
        expect(accepts({ latitude: Number.NaN, longitude: 0 })).toBe(false);
    });
});

describe("emulate_geolocation safety", () => {
    it("is refused in read-only mode", async () => {
        const { fake, runtime } = setup({
            ...managedConfig,
            safety: { ...managedConfig.safety, readOnly: true },
        });
        const args = { latitude: 1, longitude: 2 };
        const result = await runTool(emulateGeolocation, args, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("read-only mode");
        expect(fake.permissions).toEqual([]);
    });

    it("is refused for an origin outside allowedDomains before anything is sent", async () => {
        const { fake, runtime } = setup({
            ...managedConfig,
            safety: { ...managedConfig.safety, allowedDomains: ["a.example"] },
        });
        const result = await runTool(
            emulateGeolocation,
            { latitude: 1, longitude: 2, origin: OTHER },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("b.example");
        expect(fake.sent).toEqual([]);
        expect(fake.permissions).toEqual([]);
    });

    it("counts as a dangerous call unless it resets", () => {
        const dangerous = emulateGeolocation.dangerous as (args: { reset?: boolean }) => boolean;

        expect(dangerous({ reset: true })).toBe(false);
        expect(dangerous({})).toBe(true);
        expect(emulateGeolocation.summarize?.({ origin: OTHER })).toContain(OTHER);
    });
});
