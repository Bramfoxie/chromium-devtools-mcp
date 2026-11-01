import { describe, expect, it } from "vitest";
import { SessionTabs, ToolRuntime } from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

const tab = (targetId: string) => ({
    targetId,
    url    : `https://${targetId}.example/`,
    title  : `title of ${targetId}`,
    owned  : true,
    created: true,
});

describe("SessionTabs", () => {
    it("forgets a closed tab and clears the selection when it was selected", () => {
        const tabs = new SessionTabs();

        tabs.refresh([tab("a"), tab("b")], "a");
        tabs.forget("a");
        expect(tabs.knownTabs().map((known) => known.targetId)).toEqual(["b"]);
        expect(tabs.selected()).toBeUndefined();
    });

    it("keeps the selection when another tab closes", () => {
        const tabs = new SessionTabs();

        tabs.refresh([tab("a"), tab("b")], "a");
        tabs.forget("b");
        expect(tabs.selected()).toBe("a");
    });

    it("drops everything on reset", () => {
        const tabs = new SessionTabs();

        tabs.refresh([tab("a")], "a");
        tabs.reset();
        expect(tabs.knownTabs()).toEqual([]);
        expect(tabs.selected()).toBeUndefined();
    });

    it("hands out copies of the known tabs", () => {
        const tabs = new SessionTabs();

        tabs.refresh([tab("a")], "a");
        tabs.knownTabs().push(tab("b"));
        expect(tabs.knownTabs()).toHaveLength(1);
    });
});

describe("ToolRuntime", () => {
    it("exposes the live selection and known tabs in the context state", () => {
        const access = new FakeAccess();
        const tabs = new SessionTabs();
        const runtime = new ToolRuntime({ access: access.asAccess(), config: managedConfig, tabs });
        const controller = new AbortController();
        const context = runtime.context(controller.signal);

        expect(context.signal).toBe(controller.signal);
        expect(context.state.selected).toBeUndefined();
        tabs.refresh([tab("a")], "a");
        expect(context.state.selected).toBe("a");
        expect(context.state.tabs).toHaveLength(1);
    });

    it("uses a wall clock by default", async () => {
        const access = new FakeAccess();
        const runtime = new ToolRuntime({ access: access.asAccess(), config: managedConfig });

        expect(runtime.clock.now()).toBeLessThanOrEqual(Date.now());
        await expect(runtime.clock.sleep(1)).resolves.toBeUndefined();
    });
});
