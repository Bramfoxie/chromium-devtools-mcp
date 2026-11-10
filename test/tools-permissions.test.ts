import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { permissions, runTool, ToolRuntime } from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
const extra = () => ({ signal: new AbortController().signal }) as Extra;

describe("permissions", () => {
    it("sends a denied override for a specific origin", async () => {
        const fake = new FakeAccess();
        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });
        const result = await runTool(permissions, {
            name: "camera", setting: "denied", origin: "https://example.com",
        }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(fake.permissions).toContainEqual({
            name: "camera", setting: "denied", origin: "https://example.com", owner: "permissions",
        });
    });

    it("refuses a permission change in read only mode", async () => {
        const fake = new FakeAccess();
        const config = { ...managedConfig, safety: { ...managedConfig.safety, readOnly: true } };
        const runtime = new ToolRuntime({ access: fake.asAccess(), config });
        const result = await runTool(permissions, {
            name: "camera", setting: "granted", origin: "https://example.com",
        }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(fake.permissions).toEqual([]);
    });

    it("passes confirmation to the daemon when required", async () => {
        const fake = new FakeAccess();
        const config = {
            ...managedConfig, safety: { ...managedConfig.safety, confirmDangerous: true },
        };
        const runtime = new ToolRuntime({ access: fake.asAccess(), config, confirm: async () => "accepted" });
        const result = await runTool(permissions, {
            name: "microphone", setting: "granted", origin: "https://example.com",
        }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(fake.permissions).toContainEqual({
            name     : "microphone", setting  : "granted", origin   : "https://example.com",
            owner    : "permissions", confirmed: true,
        });
    });

    it("refuses an origin outside the allowlist", async () => {
        const fake = new FakeAccess();
        const config = { ...managedConfig, safety: { ...managedConfig.safety, allowedDomains: ["allowed.example"] } };
        const runtime = new ToolRuntime({ access: fake.asAccess(), config });
        const result = await runTool(permissions, {
            name: "camera", setting: "granted", origin: "https://blocked.example",
        }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(fake.permissions).toEqual([]);
    });

    it("does not change a permission when confirmation is declined", async () => {
        const fake = new FakeAccess();
        const config = {
            ...managedConfig, safety: { ...managedConfig.safety, confirmDangerous: true },
        };
        const runtime = new ToolRuntime({ access: fake.asAccess(), config, confirm: async () => "declined" });
        const result = await runTool(permissions, {
            name: "camera", setting: "granted", origin: "https://example.com",
        }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(fake.permissions).toEqual([]);
    });

    it("rejects a malformed origin before asking for confirmation", async () => {
        const fake = new FakeAccess();
        let asked = false;
        const config = {
            ...managedConfig, safety: { ...managedConfig.safety, confirmDangerous: true },
        };
        const runtime = new ToolRuntime({
            access : fake.asAccess(), config,
            confirm: async () => { asked = true;

                return "accepted"; },
        });
        const result = await runTool(permissions, {
            name: "camera", setting: "granted", origin: "https://example.com/path",
        }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(asked).toBe(false);
        expect(fake.permissions).toEqual([]);
    });

    it("refuses an origin that resolves to a private address", async () => {
        const fake = new FakeAccess();
        const config = {
            ...managedConfig, safety: { ...managedConfig.safety, allowPrivateNetworks: false },
        };
        const runtime = new ToolRuntime({
            access: fake.asAccess(), config, resolveHost: async () => ["127.0.0.1"],
        });
        const result = await runTool(permissions, {
            name: "camera", setting: "granted", origin: "https://example.com",
        }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(fake.permissions).toEqual([]);
    });
});
