import { describe, expect, it } from "vitest";
import { buildHar } from "../src/tools/capture/har.js";
import type { NetworkRecord } from "../src/tools/capture/network-log.js";

const creator = { name: "chromium-devtools-mcp", version: "9.9.9" };

function record(patch: Partial<NetworkRecord>): NetworkRecord {
    return {
        requestId   : "r1",
        method      : "GET",
        url         : "https://example.test/a?x=1&token=[redacted]",
        resourceType: "Fetch",
        fromCache   : false,
        failed      : false,
        finished    : true,
        redirect    : false,
        ...patch,
    };
}

describe("buildHar", () => {
    it("builds a HAR 1.2 log with the creator and one entry per record", () => {
        const har = buildHar([record({}), record({ requestId: "r2" })], creator);

        expect(har.log.version).toBe("1.2");
        expect(har.log.creator).toEqual(creator);
        expect(har.log.entries).toHaveLength(2);
    });

    it("maps a finished request with its headers, query, status, size and timing", () => {
        const [entry] = buildHar(
            [
                record({
                    status         : 200,
                    statusText     : "OK",
                    mimeType       : "application/json",
                    encodedBytes   : 321,
                    durationMs     : 42,
                    wallTime       : 1_700_000_000.5,
                    requestHeaders : { accept: "*/*", cookie: "[redacted]" },
                    responseHeaders: { "content-type": "application/json" },
                }),
            ],
            creator,
        ).log.entries;

        expect(entry?.startedDateTime).toBe("2023-11-14T22:13:20.500Z");
        expect(entry?.time).toBe(42);
        expect(entry?.timings).toEqual({ send: 0, wait: 42, receive: 0 });
        expect(entry?.request).toMatchObject({
            method     : "GET",
            url        : "https://example.test/a?x=1&token=[redacted]",
            queryString: [
                { name: "x", value: "1" },
                { name: "token", value: "[redacted]" },
            ],
            headers: [
                { name: "accept", value: "*/*" },
                { name: "cookie", value: "[redacted]" },
            ],
        });
        expect(entry?.response).toMatchObject({
            status    : 200,
            statusText: "OK",
            content   : { size: 321, mimeType: "application/json" },
            bodySize  : 321,
        });
    });

    it("reads the redirect target of a redirect from its location header", () => {
        const [entry] = buildHar(
            [record({ status: 302, redirect: true, responseHeaders: { Location: "https://example.test/b" } })],
            creator,
        ).log.entries;

        expect(entry?.response.redirectURL).toBe("https://example.test/b");
    });

    it("marks a failed request and a cached one with the status zero HAR expects", () => {
        const [failed, cached] = buildHar(
            [
                record({ failed: true, errorText: "net::ERR_FAILED" }),
                record({ requestId: "r2", status: 200, fromCache: true }),
            ],
            creator,
        ).log.entries;

        expect(failed?.response.status).toBe(0);
        expect(failed?._failed).toBe("net::ERR_FAILED");
        expect(cached?._fromCache).toBe(true);
        expect(failed).not.toHaveProperty("_fromCache");
    });

    it("gives a record without a wall time the time of the first record that has one", () => {
        const [first, second] = buildHar(
            [record({ wallTime: 1_700_000_000 }), record({ requestId: "ws", resourceType: "WebSocket" })],
            creator,
        ).log.entries;

        expect(second?.startedDateTime).toBe(first?.startedDateTime);
    });

    it("uses the clock when no record has a wall time and survives a bad URL", () => {
        const [entry] = buildHar([record({ url: "not a url" })], creator, () => 0).log.entries;

        expect(entry?.startedDateTime).toBe("1970-01-01T00:00:00.000Z");
        expect(entry?.request.queryString).toEqual([]);
    });

    it("carries only what the records hold, so no secret and no body appears", () => {
        const text = JSON.stringify(
            buildHar([record({ requestHeaders: { authorization: "[redacted]" } })], creator),
        );

        expect(text).not.toContain("Bearer");
        expect(text).not.toContain('"text"');
    });
});
