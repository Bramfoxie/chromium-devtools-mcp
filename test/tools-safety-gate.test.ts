import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config/index.js";
import type { SafetyRequest } from "../src/tools/safety.js";
import { allTools, runTool, ToolRuntime } from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

const gateCalls: SafetyRequest[] = [];

vi.mock("../src/tools/safety.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/tools/safety.js")>();

    return {
        ...actual,
        checkSafety: (request: SafetyRequest) => {
            gateCalls.push(request);

            return actual.checkSafety(request);
        },
    };
});

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const readOnly: Config = {
    ...managedConfig,
    safety: { ...managedConfig.safety, readOnly: true },
};

type Case = [tool: string, args: Record<string, unknown>];

const MUTATING: Case[] = [
    ["new_tab", {}],
    ["select_tab", { tab: "tab1" }],
    ["close_tab", { tab: "tab1" }],
    ["bring_to_front", { tab: "tab1" }],
    ["page_navigate", { url: "https://example.com/" }],
    ["js_evaluate", { expression: "1" }],
    ["page_wait", { expression: "true" }],
    ["page_dialogs", { action: "accept" }],
    ["page_dialogs", { policy: "dismiss" }],
    ["network_mock", { action: "clear" }],
    ["storage_write", { kind: "cookies", action: "clear", confirm: true }],
    ["screenshot", { target: { selector: "h1" } }],
    ["emulate_device", { device: "iPhone SE" }],
    ["emulate_media", { reducedMotion: "reduce" }],
    ["emulate_network", { preset: "slow-3g" }],
    ["emulate_locale", { locale: "de-DE" }],
    ["emulate_geolocation", { latitude: 52.5, longitude: 13.4 }],
    ["click", { target: { selector: "body" } }],
    ["input_click", { target: { selector: "body" } }],
    ["input_hover", { target: { selector: "body" } }],
    ["input_type", { text: "hi" }],
    ["input_key", { key: "Enter" }],
    ["input_scroll", { deltaY: 100 }],
    ["input_select", { target: { selector: "select" }, indexes: [0] }],
    ["input_upload", { target: { selector: "input" }, files: ["/tmp/a.png"] }],
    ["fill_form", { fields: [{ target: { selector: "input" }, value: "x" }] }],
    ["input_drag", { from: { selector: "body" }, to: { x: 1, y: 1 } }],
    ["perf_trace_start", { reload: true }],
];

const READING: Case[] = [
    ["list_tabs", {}],
    ["list_sessions", {}],
    ["page_info", {}],
    ["dom_query", { selector: "body" }],
    ["dom_snapshot", { uid: "1_1" }],
    ["css_inspect", { uid: "1_1" }],
    ["console_logs", {}],
    ["network_requests", {}],
    ["network_response_body", {}],
    ["network_mock", { action: "list" }],
    ["page_dialogs", {}],
    ["page_dialogs", { action: "status" }],
    ["page_wait", { selector: "body" }],
    ["storage_read", {}],
    ["page_pdf", {}],
    ["page_metrics", {}],
    ["perf_trace_start", {}],
    ["perf_trace_stop", {}],
    ["heap_snapshot", {}],
    ["screenshot", {}],
    ["list_devices", {}],
];

function toolNamed(name: string) {
    const tool = allTools.find((known) => known.name === name);

    if (tool === undefined) throw new Error(`Unknown tool ${name}`);

    return tool;
}

function runtimeOf(config: Config): ToolRuntime {
    return new ToolRuntime({ access: new FakeAccess().asAccess(), config });
}

async function refusedAsReadOnly(name: string, args: Record<string, unknown>): Promise<boolean> {
    const result = await runTool(toolNamed(name), args, extra(), runtimeOf(readOnly));

    return result.isError === true && JSON.stringify(result.content).includes("read-only mode");
}

describe("safety gate coverage", () => {
    it("covers every tool in the expected tables", () => {
        const covered = new Set([...MUTATING, ...READING].map(([name]) => name));

        expect([...covered].sort()).toEqual(allTools.map((tool) => tool.name).sort());
    });

    it.each(MUTATING)("refuses %s in read-only mode for %j", async (name, args) => {
        expect(await refusedAsReadOnly(name, args)).toBe(true);
    });

    it.each(READING)("does not refuse %s in read-only mode for %j", async (name, args) => {
        expect(await refusedAsReadOnly(name, args)).toBe(false);
    });
});

describe("safety gate inputs", () => {
    it("forwards the URL target of new_tab", async () => {
        gateCalls.length = 0;

        await runTool(toolNamed("new_tab"), { url: "https://example.org/", timeoutMs: 1 }, extra(), runtimeOf(managedConfig));

        expect(gateCalls.at(-1)).toMatchObject({
            tool  : "new_tab",
            access: "mutate",
            target: { url: "https://example.org/" },
        });
    });

    it("forwards the dangerous flag only for dangerous calls", async () => {
        const cases: Array<[string, Record<string, unknown>, boolean]> = [
            ["storage_write", { kind: "cookies", action: "clear", confirm: true }, true],
            ["input_upload", { target: { selector: "input" }, files: ["/tmp/a.png"] }, true],
            ["storage_read", { kind: "cookies" }, true],
            ["storage_read", { kind: "local" }, false],
            ["list_tabs", {}, false],
        ];

        for (const [name, args, dangerous] of cases) {
            gateCalls.length = 0;
            await runTool(toolNamed(name), args, extra(), runtimeOf(managedConfig));

            expect(gateCalls.at(-1)?.dangerous, `${name} ${JSON.stringify(args)}`).toBe(dangerous);
        }
    });
});
