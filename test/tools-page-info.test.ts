import { execFile } from "node:child_process";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import { newTab, pageDetails, pageInfo, pageInfoExpression, runTool, ToolRuntime } from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const liveValue = {
    url       : "https://example.org/page",
    title     : "Example page",
    readyState: "complete",
    viewport  : { width: 1280, height: 800, devicePixelRatio: 2 },
    scroll    : { x: 0, y: 120, maxX: 0, maxY: 900 },
};

function setup(access?: FakeAccess) {
    const fake = access ?? new FakeAccess();
    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

    return { fake, runtime };
}

describe("pageInfoExpression", () => {
    it("reads the expected fields in a real JavaScript engine", async () => {
        const script = `const window = { innerWidth: 100, innerHeight: 50, devicePixelRatio: 2, scrollX: 3, scrollY: 4 };
const document = { title: "t", readyState: "complete", documentElement: { scrollWidth: 120, scrollHeight: 200 } };
const location = { href: "https://x.example/" };
console.log(JSON.stringify(eval(${JSON.stringify(pageInfoExpression)})));`;
        const output = await new Promise<string>((resolve, reject) => {
            execFile(process.execPath, ["--input-type=module", "-e", script], (error, stdout) =>
                error ? reject(error) : resolve(stdout),
            );
        });

        expect(JSON.parse(output)).toEqual({
            url       : "https://x.example/",
            title     : "t",
            readyState: "complete",
            viewport  : { width: 100, height: 50, devicePixelRatio: 2 },
            scroll    : { x: 3, y: 4, maxX: 20, maxY: 150 },
        });
    });
});

describe("pageDetails", () => {
    it("accepts a complete value and rejects a partial one", () => {
        expect(pageDetails(liveValue)).toEqual(liveValue);
        expect(pageDetails({ ...liveValue, scroll: undefined })).toBeUndefined();
        expect(pageDetails({})).toBeUndefined();
    });
});

describe("page_info", () => {
    it("returns the live data of the selected tab", async () => {
        const fake = new FakeAccess({ evaluate: { result: { type: "object", value: liveValue } } });
        const { runtime } = setup(fake);

        await runTool(newTab, { url: "https://example.org/" }, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(pageInfo, {}, extra(), runtime);

        expect(result.structuredContent).toMatchObject({
            tab       : "tab1",
            url       : "https://example.org/page",
            title     : "Example page",
            readyState: "complete",
            viewport  : { width: 1280, height: 800, devicePixelRatio: 2 },
            scroll    : { x: 0, y: 120, maxX: 0, maxY: 900 },
            selected  : true,
            owned     : true,
            source    : "page",
            emulation : {},
        });
        expect(fake.sent[0]).toMatchObject({
            targetId: "tab1",
            method  : "Runtime.evaluate",
        });
        expect(
            (fake.sent[0]?.params as { expression?: unknown } | undefined)?.expression,
        ).toBe(pageInfoExpression);
    });

    it("reads another tab on request and marks it as not selected", async () => {
        const fake = new FakeAccess({ evaluate: { result: { type: "object", value: liveValue } } });
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(pageInfo, { tab: "tab1" }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ tab: "tab1", selected: false, source: "page" });
        expect(runtime.tabs.selected()).toBe("tab2");
    });

    it("falls back to the tab list when the page is unresponsive and names the source", async () => {
        const fake = new FakeAccess();

        fake.failSend = () => new RpcError(ErrorCode.cdpTimeout, "CDP request timed out.");
        const { runtime } = setup(fake);

        await runTool(newTab, { url: "https://example.org/" }, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(pageInfo, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            tab       : "tab1",
            url       : "https://example.org/",
            readyState: "unknown",
            source    : "tab-list",
        });
    });

    it("falls back to the tab list when the evaluation has no value", async () => {
        const fake = new FakeAccess({ evaluate: { result: { type: "undefined" } } });
        const { runtime } = setup(fake);

        await runTool(newTab, { url: "https://example.org/" }, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(pageInfo, {}, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ source: "tab-list" });
    });

    it("names new_tab when no tab is selected", async () => {
        const { runtime } = setup();
        const result = await runTool(pageInfo, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("new_tab");
    });

    it("reports a tab that vanished with an action", async () => {
        const { runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        runtime.tabs.select("ghost");
        const result = await runTool(pageInfo, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("Call list_tabs");
    });
});
