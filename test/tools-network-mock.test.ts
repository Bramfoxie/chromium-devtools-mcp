import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import {
    allTools,
    networkMock,
    ruleInputOf,
    runTool,
    ToolRuntime,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

function setup() {
    const fake = new FakeAccess({
        tabs: [
            { targetId: "tab1", url: "https://a.example/", title: "a", owned: true, created: true },
        ],
    });
    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

    runtime.mock.attach();
    runtime.tabs.refresh(
        [{ targetId: "tab1", url: "https://a.example/", title: "a", owned: true, created: true }],
        "tab1",
    );

    return { fake, runtime };
}

function textOf(result: Awaited<ReturnType<typeof runTool>>): string {
    return JSON.stringify(result.content);
}

describe("ruleInputOf", () => {
    it("needs exactly one of response and fail", () => {
        expect(() => ruleInputOf({ urlPattern: "*" })).toThrow("exactly one of response and fail");
        expect(() =>
            ruleInputOf({ urlPattern: "*", response: { status: 200 }, fail: { reason: "Failed" } }),
        ).toThrow("exactly one of response and fail");
    });

    it("encodes a text body as base64", () => {
        const input = ruleInputOf({ urlPattern: "*", response: { status: 200, body: "hi" } });

        expect(input.response?.bodyBase64).toBe(Buffer.from("hi").toString("base64"));
    });

    it("rejects a base64 body that is not valid base64", () => {
        expect(() =>
            ruleInputOf({ urlPattern: "*", response: { status: 200, bodyBase64: "not base64!" } }),
        ).toThrow("not valid base64");
        expect(() =>
            ruleInputOf({ urlPattern: "*", response: { status: 200, bodyBase64: "Yg=" } }),
        ).toThrow("not valid base64");
        expect(ruleInputOf({ urlPattern: "*", response: { status: 200, bodyBase64: "Yg==" } })
            .response?.bodyBase64).toBe("Yg==");
    });

    it("validates a body of the maximum size without exhausting the stack", () => {
        const bodyBase64 = Buffer.alloc(10 * 1024 * 1024).toString("base64");

        expect(ruleInputOf({ urlPattern: "*", response: { status: 200, bodyBase64 } })
            .response?.bodyBase64).toHaveLength(bodyBase64.length);
    });

    it("measures a text body in bytes of its encoded form", () => {
        const body = "\u00e9".repeat(5 * 1024 * 1024 + 1);

        expect(() => ruleInputOf({ urlPattern: "*", response: { status: 200, body } }))
            .toThrow("byte limit");
    });

    it("rejects both bodies", () => {
        expect(() =>
            ruleInputOf({ urlPattern: "*", response: { status: 200, body: "a", bodyBase64: "Yg==" } }),
        ).toThrow("either body or bodyBase64");
    });
});

describe("network_mock", () => {
    it("decides access by action and keeps bodies out of list", async () => {
        const found = allTools.find((tool) => tool.name === "network_mock");
        const access = found?.access as (args: unknown) => string;

        expect(access({ action: "list" })).toBe("read");
        expect(access({ action: "add" })).toBe("mutate");
        expect(access({ action: "remove" })).toBe("mutate");
        expect(access({ action: "clear" })).toBe("mutate");
    });

    it("rejects a status outside 200 to 599 and header values with line breaks", async () => {
        const { fake, runtime } = setup();

        for (const rule of [
            { urlPattern: "*", response: { status: 199 } },
            { urlPattern: "*", response: { status: 600 } },
            { urlPattern: "*", response: { status: 200, headers: { "x-a": "a\r\nset-cookie: b=1" } } },
        ]) {
            const result = await runTool(networkMock, { action: "add", rule }, extra(), runtime);

            expect(result.isError).toBe(true);
            expect(textOf(result)).toContain("Invalid arguments");
        }

        expect(fake.sent.map((call) => call.method)).not.toContain("Fetch.enable");
    });

    it("bounds the bodies of all rules together", async () => {
        const { runtime } = setup();
        const body = Buffer.alloc(10 * 1024 * 1024).toString("base64");
        const results: boolean[] = [];

        for (let index = 0; index < 7; index += 1) {
            const result = await runTool(
                networkMock,
                {
                    action: "add",
                    rule  : { urlPattern: `*/${index}`, response: { status: 200, bodyBase64: body } },
                },
                extra(),
                runtime,
            );

            results.push(result.isError === true);

            if (result.isError === true) expect(textOf(result)).toContain("Remove rules");
        }

        expect(results).toEqual([false, false, false, false, false, false, true]);
    });

    it("adds a response rule and enables Fetch", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(
            networkMock,
            {
                action: "add",
                rule  : {
                    urlPattern: "https://a.example/api",
                    response  : { status: 200, body: "secret-body", contentType: "application/json" },
                },
            },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            action: "add",
            effect: "Rule mock1 was added.",
            rules : [{ id: "mock1", urlPattern: "https://a.example/api", kind: "response", status: 200 }],
        });
        expect(JSON.stringify(result.structuredContent)).not.toContain("secret-body");
        expect(fake.sent.map((call) => call.method)).toContain("Fetch.enable");
    });

    it("resolves a paused request through the added rule", async () => {
        const { fake, runtime } = setup();

        await runTool(
            networkMock,
            { action: "add", rule: { urlPattern: "*", fail: { reason: "BlockedByClient" } } },
            extra(),
            runtime,
        );
        fake.sent.length = 0;

        await runtime.mock.handleCdpEvent({
            targetId: "tab1",
            event   : "Fetch.requestPaused",
            params  : {
                requestId   : "r1",
                request     : { url: "https://a.example/x", method: "GET" },
                resourceType: "XHR",
            },
        });

        expect(fake.sent.map((call) => call.method)).toEqual(["Fetch.failRequest"]);

        const listed = await runTool(networkMock, { action: "list" }, extra(), runtime);

        expect(listed.structuredContent).toMatchObject({
            rules: [{ id: "mock1", applications: 1 }],
        });
    });

    it("counts a request that fell back to the network as an error, not an application", async () => {
        const { fake, runtime } = setup();

        await runTool(
            networkMock,
            { action: "add", rule: { urlPattern: "*", response: { status: 200 } } },
            extra(),
            runtime,
        );
        fake.failSend = (_tab, method) =>
            method === "Fetch.fulfillRequest" ? new Error("boom") : undefined;

        await runtime.mock.handleCdpEvent({
            targetId: "tab1",
            event   : "Fetch.requestPaused",
            params  : {
                requestId   : "r1",
                request     : { url: "https://a.example/x", method: "GET" },
                resourceType: "XHR",
            },
        });

        const listed = await runTool(networkMock, { action: "list" }, extra(), runtime);

        expect(listed.structuredContent).toMatchObject({
            rules: [{ id: "mock1", applications: 0, errors: 1 }],
        });
    });

    it("removes a rule and clears all with disable on the last one", async () => {
        const { fake, runtime } = setup();

        await runTool(
            networkMock,
            { action: "add", rule: { urlPattern: "*", response: { status: 200 } } },
            extra(),
            runtime,
        );
        await runTool(
            networkMock,
            { action: "add", rule: { urlPattern: "https://b.example/*", fail: { reason: "Failed" } } },
            extra(),
            runtime,
        );

        const missing = await runTool(networkMock, { action: "remove", id: "mock9" }, extra(), runtime);

        expect(missing.isError).toBe(true);
        expect(textOf(missing)).toContain("No mock rule");

        const removed = await runTool(networkMock, { action: "remove", id: "mock1" }, extra(), runtime);

        expect(removed.structuredContent).toMatchObject({ rules: [{ id: "mock2" }] });

        const cleared = await runTool(networkMock, { action: "clear" }, extra(), runtime);

        expect(cleared.structuredContent).toMatchObject({ rules: [] });
        expect(fake.sent.map((call) => call.method)).toContain("Fetch.disable");
        expect(runtime.mock.enabled("tab1")).toBe(false);
    });

    it("rejects bad argument combinations", async () => {
        const { runtime } = setup();

        const missing = await runTool(networkMock, { action: "add" }, extra(), runtime);

        expect(textOf(missing)).toContain("needs a rule");

        const both = await runTool(
            networkMock,
            { action: "add", rule: { urlPattern: "*", response: { status: 200 } }, id: "mock1" },
            extra(),
            runtime,
        );

        expect(textOf(both)).toContain("only applies to the remove action");

        const listed = await runTool(
            networkMock,
            { action: "list", id: "mock1" },
            extra(),
            runtime,
        );

        expect(textOf(listed)).toContain("takes no rule or id");
    });

    it("allows list in read-only mode and refuses changes", async () => {
        const readOnly: Config = {
            ...managedConfig,
            safety: { ...managedConfig.safety, readOnly: true },
        };
        const fake = new FakeAccess({
            tabs: [
                { targetId: "tab1", url: "https://a.example/", title: "a", owned: true, created: true },
            ],
        });
        const runtime = new ToolRuntime({ access: fake.asAccess(), config: readOnly });

        runtime.tabs.refresh(
            [{ targetId: "tab1", url: "https://a.example/", title: "a", owned: true, created: true }],
            "tab1",
        );

        const listed = await runTool(networkMock, { action: "list" }, extra(), runtime);

        expect(listed.isError).not.toBe(true);

        for (const args of [
            { action: "add", rule: { urlPattern: "*", fail: { reason: "Failed" } } },
            { action: "remove", id: "mock1" },
            { action: "clear" },
        ]) {
            const result = await runTool(networkMock, args, extra(), runtime);

            expect(result.isError).toBe(true);
            expect(textOf(result)).toContain("read-only mode");
        }
    });
});
