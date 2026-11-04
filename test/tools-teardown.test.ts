import { describe, expect, it } from "vitest";
import { ToolRuntime } from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

function setup() {
    const fake = new FakeAccess({
        tabs: [
            { targetId: "tab1", url: "https://a.example/", title: "a", owned: true, created: true },
            { targetId: "tab2", url: "https://b.example/", title: "b", owned: true, created: true },
        ],
    });
    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

    runtime.attach();

    return { fake, runtime };
}

function consoleCall(tab: string): unknown {
    return {
        targetId: tab,
        event   : "Runtime.consoleAPICalled",
        params  : { type: "log", args: [{ type: "string", value: "hello" }] },
    };
}

describe("tool runtime teardown", () => {
    it("forgets every per-tab manager when the daemon reports a closed tab", async () => {
        const { fake, runtime } = setup();

        await runtime.capture.ensureConsole("tab1");
        await runtime.capture.ensureConsole("tab2");
        await runtime.frames.ensure("tab1");
        runtime.tabs.refresh(fake.tabs, "tab1");
        fake.emit("cdp.event", consoleCall("tab1"));

        fake.emit("tab.closed", { targetId: "tab1" });

        expect(runtime.capture.consoleEnabled("tab1")).toBe(false);
        expect(runtime.capture.consoleEnabled("tab2")).toBe(true);
        expect(runtime.frames.ensured("tab1")).toBe(false);
        expect(runtime.tabs.selected()).toBeUndefined();
        expect(runtime.tabs.knownTabs().map((tab) => tab.targetId)).toEqual(["tab2"]);
    });

    it("ignores a closed event without a tab id", async () => {
        const { fake, runtime } = setup();

        await runtime.capture.ensureConsole("tab1");
        fake.emit("tab.closed", { targetId: 5 });
        fake.emit("tab.closed", null);

        expect(runtime.capture.consoleEnabled("tab1")).toBe(true);
    });

    it("forgetTab disables interception rules of the tab", async () => {
        const { fake, runtime } = setup();

        runtime.mock.add("tab1", {
            urlPattern  : "*",
            method      : undefined,
            resourceType: undefined,
            response    : undefined,
            fail        : "Failed",
            delayMs     : 0,
            times       : undefined,
        });
        await runtime.mock.sync("tab1");
        await runtime.forgetTab("tab1");

        expect(fake.sent.map((call) => call.method)).toContain("Fetch.disable");
        expect(runtime.mock.rulesOf("tab1")).toEqual([]);
    });

    it("clears every manager when the session is reset", async () => {
        const { fake, runtime } = setup();

        await runtime.capture.ensureConsole("tab1");
        runtime.tabs.refresh(fake.tabs, "tab1");
        fake.bumpGeneration();
        await Promise.resolve();

        expect(runtime.capture.consoleEnabled("tab1")).toBe(false);
        expect(runtime.tabs.knownTabs()).toEqual([]);
        expect(runtime.tabs.selected()).toBeUndefined();
    });
});
