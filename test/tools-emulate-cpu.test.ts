import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { emulateCpu, runTool, ToolRuntime } from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

function setup(config: Config = managedConfig) {
    const fake = new FakeAccess({
        tabs: [{ targetId: "tab1", url: "https://a.example/", title: "t", owned: true, created: true }],
    });
    const runtime = new ToolRuntime({ access: fake.asAccess(), config });

    runtime.tabs.select("tab1");

    return { fake, runtime };
}

const rates = (fake: FakeAccess) =>
    fake.sent
        .filter((call) => call.method === "Emulation.setCPUThrottlingRate")
        .map((call) => (call.params as { rate: number }).rate);

describe("emulate_cpu", () => {
    it("slows the tab down and reports the slowdown in the emulation state", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(emulateCpu, { slowdown: 4 }, extra(), runtime);

        expect(result.isError).toBeUndefined();
        expect(rates(fake)).toEqual([4]);
        expect(result.structuredContent).toMatchObject({
            tab      : "tab1",
            emulation: { cpu: { slowdown: 4 } },
        });
    });

    it("restores full speed with a slowdown of 1 or reset and drops the state", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateCpu, { slowdown: 6 }, extra(), runtime);

        const back = await runTool(emulateCpu, { slowdown: 1 }, extra(), runtime);

        expect(back.structuredContent).toMatchObject({ emulation: {} });
        expect(JSON.stringify(back.structuredContent)).not.toContain("cpu");

        await runTool(emulateCpu, { slowdown: 3 }, extra(), runtime);
        await runTool(emulateCpu, { reset: true }, extra(), runtime);

        expect(rates(fake)).toEqual([6, 1, 3, 1]);
    });

    it("needs a slowdown or reset, and refuses both together and out of range values", async () => {
        const { fake, runtime } = setup();

        const bad = [{}, { slowdown: 2, reset: true }, { slowdown: 0.5 }, { slowdown: 21 }];

        for (const args of bad) {
            const result = await runTool(emulateCpu, args, extra(), runtime);

            expect(result.isError).toBe(true);
        }

        expect(rates(fake)).toEqual([]);
    });

    it("keeps the previous slowdown when the browser refuses the change", async () => {
        const { fake, runtime } = setup();

        await runTool(emulateCpu, { slowdown: 2 }, extra(), runtime);
        fake.failSend = (_tab, method) =>
            method === "Emulation.setCPUThrottlingRate" ? new Error("gone") : undefined;

        const failed = await runTool(emulateCpu, { slowdown: 8 }, extra(), runtime);

        expect(failed.isError).toBe(true);
        expect(runtime.emulation.snapshot("tab1").cpu).toEqual({ slowdown: 2 });
    });

    it("is refused in read-only mode", async () => {
        const { fake, runtime } = setup({
            ...managedConfig,
            safety: { ...managedConfig.safety, readOnly: true },
        });
        const result = await runTool(emulateCpu, { slowdown: 4 }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(rates(fake)).toEqual([]);
    });
});
