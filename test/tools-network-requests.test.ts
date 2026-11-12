import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { networkFilterOf, networkHar, networkRequests, newTab, runTool, ToolRuntime } from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

function setup(access?: FakeAccess, artifacts?: ConstructorParameters<typeof ToolRuntime>[0]["artifacts"]) {
    const fake = access ?? new FakeAccess();
    const runtime = new ToolRuntime({
        access: fake.asAccess(),
        config: managedConfig,
        ...(artifacts === undefined ? {} : { artifacts }),
    });

    runtime.capture.attach();

    return { fake, runtime };
}

function requestEvent(targetId: string, requestId: string, url: string, method = "GET") {
    return {
        targetId,
        event : "Network.requestWillBeSent",
        params: {
            requestId,
            request: {
                url,
                method,
                headers: { authorization: "Bearer secret", "content-type": "application/json" },
            },
            timestamp: 100,
            type     : "XHR",
        },
    };
}

function responseEvent(targetId: string, requestId: string, status: number) {
    return {
        targetId,
        event : "Network.responseReceived",
        params: {
            requestId,
            timestamp: 101,
            type     : "XHR",
            response : {
                url       : "https://ignored.example/",
                status,
                statusText: status === 200 ? "OK" : "Error",
                mimeType  : "application/json",
                headers   : { "set-cookie": "session=abc", "content-type": "application/json" },
            },
        },
    };
}

describe("networkFilterOf", () => {
    it("builds a filter and reports an invalid pattern as a tool error", () => {
        const filter = networkFilterOf({ urlRegex: "items/\\d+", statusMin: 200, failedOnly: false });

        expect(filter.urlPattern?.test("https://a.example/items/42")).toBe(true);
        expect(() => networkFilterOf({ urlRegex: "(oops" })).toThrow(
            "The pattern is not a valid regular expression.",
        );
    });
});

describe("network_har", () => {
    it("keeps requests received while the HAR file is being saved", async () => {
        let resume: (() => void) | undefined;
        const pending = new Promise<void>((resolve) => { resume = resolve; });
        let markStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => { markStarted = resolve; });
        const artifacts = {
            write: async () => {
                markStarted?.();
                await pending;

                return { path: "/tmp/network.har", bytes: 1 };
            },
            directory: () => Promise.reject(new Error("not used")),
        };
        const { fake, runtime } = setup(undefined, artifacts);

        await runTool(newTab, {}, extra(), runtime);
        await runTool(networkRequests, {}, extra(), runtime);
        fake.emit("cdp.event", requestEvent("tab1", "r1", "https://a.example/first"));
        const saving = runTool(networkHar, { clear: true }, extra(), runtime);

        await started;
        fake.emit("cdp.event", requestEvent("tab1", "r2", "https://a.example/second"));
        resume?.();
        const saved = await saving;
        const result = await runTool(networkRequests, {}, extra(), runtime);

        expect(saved.isError).not.toBe(true);
        expect(result.structuredContent?.requests).toEqual([
            expect.objectContaining({ requestId: "r2" }),
        ]);
    });

    it("keeps updates to a request while the HAR file is being saved", async () => {
        let resume: (() => void) | undefined;
        let markStarted: (() => void) | undefined;
        const pending = new Promise<void>((resolve) => { resume = resolve; });
        const started = new Promise<void>((resolve) => { markStarted = resolve; });
        const artifacts = {
            write: async () => {
                markStarted?.();
                await pending;

                return { path: "/tmp/network.har", bytes: 1 };
            },
            directory: () => Promise.reject(new Error("not used")),
        };
        const { fake, runtime } = setup(undefined, artifacts);

        await runTool(newTab, {}, extra(), runtime);
        await runTool(networkRequests, {}, extra(), runtime);
        fake.emit("cdp.event", requestEvent("tab1", "r1", "https://a.example/first"));
        const saving = runTool(networkHar, { clear: true }, extra(), runtime);

        await started;
        fake.emit("cdp.event", responseEvent("tab1", "r1", 200));
        resume?.();
        await saving;
        const result = await runTool(networkRequests, {}, extra(), runtime);

        expect(result.structuredContent?.requests).toEqual([
            expect.objectContaining({ requestId: "r1", status: 200 }),
        ]);
    });

    it.each(["clear", "reset"] as const)("preserves a newer capture after %s during a save", async (action) => {
        let resume: (() => void) | undefined;
        let markStarted: (() => void) | undefined;
        const pending = new Promise<void>((resolve) => { resume = resolve; });
        const started = new Promise<void>((resolve) => { markStarted = resolve; });
        const artifacts = {
            write: async () => {
                markStarted?.();
                await pending;

                return { path: "/tmp/network.har", bytes: 1 };
            },
            directory: () => Promise.reject(new Error("not used")),
        };
        const { fake, runtime } = setup(undefined, artifacts);

        await runTool(newTab, {}, extra(), runtime);
        await runTool(networkRequests, {}, extra(), runtime);
        fake.emit("cdp.event", requestEvent("tab1", "r1", "https://a.example/first"));
        const saving = runTool(networkHar, { clear: true }, extra(), runtime);

        await started;

        if (action === "clear") {
            await runTool(networkRequests, { clear: true }, extra(), runtime);
        } else {
            runtime.capture.reset();
            await runTool(networkRequests, {}, extra(), runtime);
        }

        fake.emit("cdp.event", requestEvent("tab1", "r2", "https://a.example/second"));
        resume?.();
        await saving;
        const result = await runTool(networkRequests, {}, extra(), runtime);

        expect(result.structuredContent?.requests).toEqual([
            expect.objectContaining({ requestId: "r2" }),
        ]);
    });

    it("retains the dropped count when saving a HAR fails", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        await runTool(networkRequests, {}, extra(), runtime);

        for (let index = 0; index < 2001; index += 1) {
            fake.emit("cdp.event", requestEvent("tab1", `r${index}`, "https://a.example/data"));
        }

        const saved = await runTool(networkHar, { clear: true }, extra(), runtime);
        const result = await runTool(networkRequests, {}, extra(), runtime);

        expect(saved.isError).toBe(true);
        expect(result.structuredContent?.droppedCount).toBe(1);
    });

    it("retains the network buffer when saving a HAR fails", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        await runTool(networkRequests, {}, extra(), runtime);
        fake.emit("cdp.event", requestEvent("tab1", "r1", "https://a.example/data"));
        const saved = await runTool(networkHar, { clear: true }, extra(), runtime);
        const result = await runTool(networkRequests, {}, extra(), runtime);

        expect(saved.isError).toBe(true);
        expect(result.structuredContent?.requests).toEqual(expect.arrayContaining([
            expect.objectContaining({ requestId: "r1" }),
        ]));
    });
});

describe("network_requests", () => {
    it("reports available timing phases and omits unavailable offsets", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        fake.emit("cdp.event", requestEvent("tab1", "r1", "https://a.example/data"));
        const event = responseEvent("tab1", "r1", 200);

        Object.assign(event.params.response, { timing: {
            dnsStart         : 0,
            dnsEnd           : 2.2,
            connectStart     : 2.2,
            connectEnd       : 20,
            sslStart         : 10,
            sslEnd           : 19,
            sendStart        : 20,
            sendEnd          : 21,
            receiveHeadersEnd: 31,
        } });
        fake.emit("cdp.event", event);
        const result = await runTool(networkRequests, {}, extra(), runtime);

        expect(result.structuredContent?.requests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                timing: { dnsMs: 2.2, connectMs: 17.8, tlsMs: 9, sendMs: 1, waitMs: 10 },
            }),
        ]));
        const invalid = responseEvent("tab1", "r2", 200);

        Object.assign(invalid.params.response, {
            timing: { dnsStart: -1, dnsEnd: -1, sendStart: 5, sendEnd: 2 },
        });
        fake.emit("cdp.event", invalid);
        const partial = await runTool(networkRequests, {}, extra(), runtime);
        const entries = partial.structuredContent?.requests as Array<{
            requestId: string; timing?: unknown;
        }>;

        expect(entries.find((item) => item.requestId === "r2")?.timing).toBeUndefined();
    });

    it("enables network capture lazily and reports redacted records", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        expect(runtime.capture.networkEnabled("tab1")).toBe(false);
        expect(fake.sent.map((call) => call.method)).not.toContain("Network.enable");
        fake.sent.length = 0;

        fake.emit("cdp.event", requestEvent("tab1", "r1", "https://a.example/data?token=abc&page=2"));
        fake.emit("cdp.event", responseEvent("tab1", "r1", 200));
        const result = await runTool(networkRequests, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(runtime.capture.networkEnabled("tab1")).toBe(true);
        expect(fake.sent.map((call) => call.method)).toEqual(["Network.enable"]);
        expect(result.structuredContent).toMatchObject({
            tab          : "tab1",
            nextAfterId  : 1,
            droppedCount : 0,
            returned     : 1,
            totalBuffered: 1,
        });
        expect(
            (result.structuredContent as { requests: unknown }).requests,
        ).toEqual([
            {
                id          : 1,
                requestId   : "r1",
                method      : "GET",
                url         : "https://a.example/data?token=[redacted]&page=2",
                resourceType: "XHR",
                status      : 200,
                statusText  : "OK",
                mimeType    : "application/json",
                fromCache   : false,
                failed      : false,
                finished    : false,
            },
        ]);
    });

    it("includes redacted headers only when asked", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        fake.emit("cdp.event", requestEvent("tab1", "r1", "https://a.example/data"));
        fake.emit("cdp.event", responseEvent("tab1", "r1", 200));

        const plain = await runTool(networkRequests, {}, extra(), runtime);
        const hidden = plain.structuredContent as { requests: Array<Record<string, unknown>> };

        expect(hidden.requests[0]).not.toHaveProperty("requestHeaders");
        expect(hidden.requests[0]).not.toHaveProperty("responseHeaders");

        const shown = await runTool(networkRequests, { includeHeaders: true }, extra(), runtime);
        const headers = shown.structuredContent as {
            requests: Array<{ requestHeaders: unknown; responseHeaders: unknown }>;
        };

        expect(headers.requests[0]?.requestHeaders).toEqual({
            authorization : "[redacted]",
            "content-type": "application/json",
        });
        expect(headers.requests[0]?.responseHeaders).toEqual({
            "set-cookie"  : "[redacted]",
            "content-type": "application/json",
        });
    });

    it("filters by url, method, status and failure with paging and clear", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        fake.emit("cdp.event", requestEvent("tab1", "r1", "https://a.example/items/1"));
        fake.emit("cdp.event", responseEvent("tab1", "r1", 200));
        fake.emit("cdp.event", requestEvent("tab1", "r2", "https://a.example/other", "POST"));
        fake.emit("cdp.event", responseEvent("tab1", "r2", 500));
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Network.loadingFailed",
            params  : { requestId: "r2", timestamp: 102, errorText: "net::ERR_FAILED" },
        });

        const urls = await runTool(
            networkRequests,
            { urlContains: "items", urlRegex: "items/\\d+" },
            extra(),
            runtime,
        );

        expect((urls.structuredContent as { returned: number }).returned).toBe(1);

        const methods = await runTool(networkRequests, { methods: ["POST"] }, extra(), runtime);

        expect((methods.structuredContent as { returned: number }).returned).toBe(1);

        const failed = await runTool(
            networkRequests,
            { failedOnly: true, statusMin: 500, statusMax: 599 },
            extra(),
            runtime,
        );
        const failures = failed.structuredContent as {
            requests: Array<{ failed: boolean; errorText?: string }>;
        };

        expect(failures.requests).toEqual([{ failed: true, errorText: "net::ERR_FAILED" }].map(
            (match) => expect.objectContaining(match),
        ));

        const page = await runTool(networkRequests, { afterId: 1, limit: 1 }, extra(), runtime);

        expect((page.structuredContent as { nextAfterId: number }).nextAfterId).toBe(2);

        const cleared = await runTool(networkRequests, { clear: true }, extra(), runtime);

        expect((cleared.structuredContent as { returned: number }).returned).toBe(2);

        const next = await runTool(networkRequests, {}, extra(), runtime);

        expect((next.structuredContent as { returned: number }).returned).toBe(0);
    });

    it("reports an invalid regex as a tool error without enabling capture", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;
        const result = await runTool(networkRequests, { urlRegex: "(oops" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("valid regular expression");
        expect(fake.sent).toEqual([]);
        expect(runtime.capture.networkEnabled("tab1")).toBe(false);
    });

    it("reads another tab and names new_tab without a selection", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        await runTool(newTab, {}, extra(), runtime);
        fake.emit("cdp.event", requestEvent("tab1", "r1", "https://a.example/data"));
        const result = await runTool(networkRequests, { tab: "tab1" }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ tab: "tab1", returned: 1 });

        const { runtime: empty } = setup();
        const missing = await runTool(networkRequests, {}, extra(), empty);

        expect(missing.isError).toBe(true);
        expect(JSON.stringify(missing.content)).toContain("new_tab");
    });
});
