import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import {
    bodyByteSize,
    isTextMimeType,
    networkResponseBody,
    newTab,
    runTool,
    ToolRuntime,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

function setup(access?: FakeAccess) {
    const fake = access ?? new FakeAccess();
    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

    runtime.capture.attach();

    return { fake, runtime };
}

function finishedRequest(targetId: string, requestId: string, mimeType = "application/json") {
    return [
        {
            targetId,
            event : "Network.requestWillBeSent",
            params: {
                requestId,
                request  : { url: `https://a.example/${requestId}`, method: "GET" },
                timestamp: 100,
                type     : "XHR",
            },
        },
        {
            targetId,
            event : "Network.responseReceived",
            params: {
                requestId,
                timestamp: 101,
                type     : "XHR",
                response : {
                    url       : `https://a.example/${requestId}`,
                    status    : 200,
                    statusText: "OK",
                    mimeType,
                    headers   : {},
                },
            },
        },
        {
            targetId,
            event : "Network.loadingFinished",
            params: { requestId, timestamp: 102, encodedDataLength: 10 },
        },
    ];
}

describe("body helpers", () => {
    it("classifies text mime types and measures bodies", () => {
        expect(isTextMimeType("text/html; charset=utf-8")).toBe(true);
        expect(isTextMimeType("application/json")).toBe(true);
        expect(isTextMimeType("application/problem+json")).toBe(true);
        expect(isTextMimeType("image/svg+xml")).toBe(true);
        expect(isTextMimeType("application/javascript")).toBe(true);
        expect(isTextMimeType("image/png")).toBe(false);
        expect(isTextMimeType(undefined)).toBe(false);
        expect(bodyByteSize("hello", false)).toBe(5);
        expect(bodyByteSize(Buffer.from("hello").toString("base64"), true)).toBe(5);
    });
});

describe("network_response_body", () => {
    it("reads a text body through the browser request id", async () => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method, params) => {
            if (method === "Network.getResponseBody") {
                expect(params).toEqual({ requestId: "cdp-7" });

                return { body: "{\"ok\":true}", base64Encoded: false };
            }

            return {};
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        for (const event of finishedRequest("tab1", "cdp-7")) fake.emit("cdp.event", event);

        const result = await runTool(networkResponseBody, { requestId: 1 }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({
            tab      : "tab1",
            requestId: 1,
            mimeType : "application/json",
            size     : 11,
            base64   : false,
            body     : "{\"ok\":true}",
        });
    });

    it("decodes base64 text bodies and truncates with the marker", async () => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) =>
            method === "Network.getResponseBody"
                ? { body: Buffer.from("abcdef").toString("base64"), base64Encoded: true }
                : {};
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        for (const event of finishedRequest("tab1", "r1")) fake.emit("cdp.event", event);

        const result = await runTool(
            networkResponseBody,
            { requestId: 1, maxChars: 4 },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({
            base64     : false,
            body       : "abcd[truncated: 2 of 6 characters omitted]",
            truncated  : true,
            totalLength: 6,
        });
    });

    it("reports binary bodies without base64 and returns them when asked", async () => {
        const fake = new FakeAccess();
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

        fake.respond = (_targetId, method) =>
            method === "Network.getResponseBody" ? { body: bytes, base64Encoded: true } : {};
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        for (const event of finishedRequest("tab1", "r1", "image/png")) fake.emit("cdp.event", event);

        const plain = await runTool(networkResponseBody, { requestId: 1 }, extra(), runtime);

        expect(plain.structuredContent).toEqual({
            tab        : "tab1",
            requestId  : 1,
            mimeType   : "image/png",
            size       : 4,
            base64     : false,
            needsBase64: true,
        });

        const encoded = await runTool(
            networkResponseBody,
            { requestId: 1, asBase64: true },
            extra(),
            runtime,
        );

        expect(encoded.structuredContent).toMatchObject({ base64: true, body: bytes, size: 4 });
        expect(() =>
            Buffer.from(
                (encoded.structuredContent as { body: string }).body,
                "base64",
            ),
        ).not.toThrow();
    });

    it("truncates base64 on a 4-char boundary outside the data", async () => {
        const fake = new FakeAccess();
        const bytes = Buffer.from("0123456789").toString("base64");

        fake.respond = (_targetId, method) =>
            method === "Network.getResponseBody" ? { body: bytes, base64Encoded: true } : {};
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        for (const event of finishedRequest("tab1", "r1", "image/png")) fake.emit("cdp.event", event);

        const result = await runTool(
            networkResponseBody,
            { requestId: 1, asBase64: true, maxChars: 7 },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({
            base64     : true,
            body       : bytes.slice(0, 4),
            truncated  : true,
            totalLength: bytes.length,
        });
        expect(
            (result.structuredContent as { body: string }).body.length % 4,
        ).toBe(0);
    });

    it("maps unknown ids, redirects, loading and evicted bodies", async () => {
        const fake = new FakeAccess();

        fake.respond = () => ({});
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        const unknown = await runTool(networkResponseBody, { requestId: 7 }, extra(), runtime);

        expect(unknown.isError).toBe(true);
        expect(JSON.stringify(unknown.content)).toContain("network_requests");

        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Network.requestWillBeSent",
            params  : {
                requestId: "r1",
                request  : { url: "https://a.example/a", method: "GET" },
                timestamp: 100,
                type     : "Document",
            },
        });
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Network.requestWillBeSent",
            params  : {
                requestId       : "r1",
                request         : { url: "https://a.example/b", method: "GET" },
                timestamp       : 101,
                type            : "Document",
                redirectResponse: { url: "https://a.example/a", status: 301, statusText: "Moved", headers: {} },
            },
        });

        const redirect = await runTool(networkResponseBody, { requestId: 1 }, extra(), runtime);

        expect(redirect.isError).toBe(true);
        expect(JSON.stringify(redirect.content)).toContain("Redirect responses have no body");

        const loading = await runTool(networkResponseBody, { requestId: 2 }, extra(), runtime);

        expect(loading.isError).toBe(true);
        expect(JSON.stringify(loading.content)).toContain("still loading");
    });

    it("reports a body the browser evicted", async () => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) => {
            if (method === "Network.getResponseBody") {
                throw new RpcError(ErrorCode.cdpError, "No data found for resource");
            }

            return {};
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        for (const event of finishedRequest("tab1", "r1")) fake.emit("cdp.event", event);

        const result = await runTool(networkResponseBody, { requestId: 1 }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("no longer has the body");
    });

    it("refuses a body larger than the transport limit", async () => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) =>
            method === "Network.getResponseBody"
                ? { body: "x".repeat(33 * 1024 * 1024), base64Encoded: false }
                : {};
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        for (const event of finishedRequest("tab1", "r1")) fake.emit("cdp.event", event);

        const result = await runTool(networkResponseBody, { requestId: 1 }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("32 MiB");
    });

    it("names new_tab without a selection", async () => {
        const { runtime } = setup();
        const result = await runTool(networkResponseBody, { requestId: 1 }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("new_tab");
    });
});
