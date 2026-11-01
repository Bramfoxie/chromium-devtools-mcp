import { execFile } from "node:child_process";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
    NAVIGATION_TIMING_EXPRESSION,
    newTab,
    pageMetrics,
    runTool,
    shapePerformanceMetrics,
    ToolRuntime,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

function setup(access?: FakeAccess) {
    const fake = access ?? new FakeAccess();
    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

    return { fake, runtime };
}

describe("shapePerformanceMetrics", () => {
    it("renames, converts and drops zero noise", () => {
        expect(
            shapePerformanceMetrics([
                { name: "Timestamp", value: 123.456 },
                { name: "Documents", value: 2 },
                { name: "Nodes", value: 0 },
                { name: "FirstMeaningfulPaint", value: 0 },
                { name: "ScriptDuration", value: 0.012345 },
                { name: "LayoutDuration", value: 0 },
                { name: "JSHeapUsedSize", value: 1024.6 },
            ]),
        ).toEqual({
            documents       : 2,
            nodes           : 0,
            scriptDurationMs: 12.35,
            jsHeapUsedBytes : 1024.6,
        });
    });
});

describe("NAVIGATION_TIMING_EXPRESSION", () => {
    it("reads the navigation entry in a real JavaScript engine", async () => {
        const script = `const performance = { getEntriesByType: () => [{
  startTime: 0, domainLookupStart: 10, domainLookupEnd: 30, connectStart: 30,
  connectEnd: 60, responseStart: 60, responseEnd: 110,
  domContentLoadedEventEnd: 200, loadEventEnd: 250,
}] };
console.log(JSON.stringify(eval(${JSON.stringify(NAVIGATION_TIMING_EXPRESSION)})));`;
        const output = await new Promise<string>((resolve, reject) => {
            execFile(process.execPath, ["--input-type=module", "-e", script], (error, stdout) =>
                error ? reject(error) : resolve(stdout),
            );
        });

        expect(JSON.parse(output)).toEqual({
            dnsMs             : 20,
            connectMs         : 30,
            responseMs        : 50,
            domContentLoadedMs: 200,
            loadMs            : 250,
        });
    });

    it("returns null without a navigation entry", async () => {
        const script = `const performance = { getEntriesByType: () => [] };
console.log(JSON.stringify(eval(${JSON.stringify(NAVIGATION_TIMING_EXPRESSION)})));`;
        const output = await new Promise<string>((resolve, reject) => {
            execFile(process.execPath, ["--input-type=module", "-e", script], (error, stdout) =>
                error ? reject(error) : resolve(stdout),
            );
        });

        expect(JSON.parse(output)).toBeNull();
    });
});

describe("page_metrics", () => {
    function metricsFake(navigation: unknown = { dnsMs: 1 }) {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) => {
            switch (method) {
                case "Performance.getMetrics":
                    return {
                        metrics: [
                            { name: "Documents", value: 1 },
                            { name: "Frames", value: 1 },
                            { name: "Nodes", value: 42 },
                            { name: "JSEventListeners", value: 7 },
                            { name: "LayoutCount", value: 3 },
                            { name: "ScriptDuration", value: 0.05 },
                            { name: "JSHeapUsedSize", value: 8000 },
                            { name: "JSHeapTotalSize", value: 16000 },
                        ],
                    };
                case "Page.getLayoutMetrics":
                    return {
                        layoutViewport: {
                            pageX       : 0,
                            pageY       : 120.6,
                            clientWidth : 1280,
                            clientHeight: 720,
                        },
                        contentSize: { width: 1280, height: 2000.4 },
                    };
                case "Runtime.evaluate":
                    return { result: { type: "object", value: navigation } };
                default:
                    return {};
            }
        };

        return fake;
    }

    it("groups performance, layout and navigation and disables the domain", async () => {
        const { fake, runtime } = setup(metricsFake());

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;
        const result = await runTool(pageMetrics, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({
            tab        : "tab1",
            performance: {
                documents       : 1,
                frames          : 1,
                nodes           : 42,
                listeners       : 7,
                layoutCount     : 3,
                scriptDurationMs: 50,
                jsHeapUsedBytes : 8000,
                jsHeapTotalBytes: 16000,
            },
            layout: {
                viewport   : { width: 1280, height: 720 },
                contentSize: { width: 1280, height: 2000 },
                scroll     : { x: 0, y: 121 },
            },
            navigation: { dnsMs: 1 },
        });
        expect(fake.sent.map((call) => call.method)).toEqual([
            "Performance.enable",
            "Performance.getMetrics",
            "Page.getLayoutMetrics",
            "Runtime.evaluate",
            "Performance.disable",
        ]);
        expect(fake.sent[3]?.params).toMatchObject({ expression: NAVIGATION_TIMING_EXPRESSION });
    });

    it("omits navigation when the page has none and still disables", async () => {
        const { fake, runtime } = setup(metricsFake(null));

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;
        const result = await runTool(pageMetrics, {}, extra(), runtime);

        expect(result.structuredContent).not.toHaveProperty("navigation");
        expect(fake.sent.map((call) => call.method)).toContain("Performance.disable");
    });

    it("disables the domain even when reading fails", async () => {
        const fake = metricsFake();

        fake.respond = (_targetId, method) => {
            if (method === "Page.getLayoutMetrics") return { unexpected: true };

            return metricsFake().respond?.(_targetId, method, undefined);
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(pageMetrics, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(fake.sent.map((call) => call.method)).toContain("Performance.disable");
    });

    it("names new_tab without a selection", async () => {
        const { runtime } = setup();
        const result = await runTool(pageMetrics, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("new_tab");
    });
});
