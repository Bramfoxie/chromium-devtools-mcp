import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { bringToFront, runTool, ToolRuntime } from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const focusing: Config = { ...managedConfig, allowFocus: true };

function tabAt(targetId: string, url: string) {
    return { targetId, url, title: "t", owned: true, created: true };
}

function setup(config: Config, selected?: string) {
    const fake = new FakeAccess({
        tabs: [tabAt("tab1", "https://example.com/"), tabAt("tab2", "https://evil.test/")],
    });
    const runtime = new ToolRuntime({ access: fake.asAccess(), config });

    if (selected !== undefined) runtime.tabs.select(selected);

    return { fake, runtime };
}

const text = (result: { content: unknown }) => JSON.stringify(result.content);

describe("bring_to_front", () => {
    it("is refused with an actionable message while allowFocus is off", async () => {
        const { fake, runtime } = setup(managedConfig, "tab1");
        const result = await runTool(bringToFront, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("allowFocus");
        expect(fake.sent).toEqual([]);
    });

    it("brings the selected tab to the front when allowFocus is on", async () => {
        const { fake, runtime } = setup(focusing, "tab1");
        const result = await runTool(bringToFront, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({ tab: "tab1" });
        expect(fake.sent).toEqual([
            expect.objectContaining({ targetId: "tab1", method: "Page.bringToFront" }),
        ]);
    });

    it("takes an explicit tab and leaves the selection alone", async () => {
        const { fake, runtime } = setup(focusing, "tab1");
        const result = await runTool(bringToFront, { tab: "tab2" }, extra(), runtime);

        expect(result.structuredContent).toEqual({ tab: "tab2" });
        expect(fake.sent[0]?.targetId).toBe("tab2");
        expect(runtime.tabs.selected()).toBe("tab1");
    });

    it("asks for a tab when none is selected", async () => {
        const { fake, runtime } = setup(focusing);
        const result = await runTool(bringToFront, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("new_tab");
        expect(fake.sent).toEqual([]);
    });

    it("is refused in read-only mode", async () => {
        const config: Config = {
            ...focusing,
            safety: { ...focusing.safety, readOnly: true },
        };
        const { fake, runtime } = setup(config, "tab1");
        const result = await runTool(bringToFront, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("read-only mode");
        expect(fake.sent).toEqual([]);
    });

    it("is refused on a tab outside allowedDomains", async () => {
        const config: Config = {
            ...focusing,
            safety: { ...focusing.safety, allowedDomains: ["example.com"] },
        };
        const { fake, runtime } = setup(config, "tab2");
        const result = await runTool(bringToFront, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("evil.test");
        expect(fake.sent).toEqual([]);

        const allowed = await runTool(bringToFront, { tab: "tab1" }, extra(), runtime);

        expect(allowed.isError).not.toBe(true);
    });
});
