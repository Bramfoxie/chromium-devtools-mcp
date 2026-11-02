import { describe, expect, it } from "vitest";
import {
    headersForCdp,
    InterceptionManager,
    matchWildcard,
    ruleMatches,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";

const clock = { now: () => 1_700_000_000_000, sleep: async () => undefined };

function interception(fake = new FakeAccess()) {
    const manager = new InterceptionManager({ access: fake.asAccess(), clock });

    manager.attach();

    return { fake, manager };
}

describe("matchWildcard", () => {
    it("matches Fetch wildcards", () => {
        expect(matchWildcard("*", "https://a.example/x")).toBe(true);
        expect(matchWildcard("https://a.example/*", "https://a.example/api/v1")).toBe(true);
        expect(matchWildcard("https://a.example/*", "https://b.example/api")).toBe(false);
        expect(matchWildcard("*.example/file?.json", "https://a.example/file1.json")).toBe(true);
        expect(matchWildcard("*.example/file?.json", "https://a.example/file12.json")).toBe(false);
    });

    it("treats regex characters as literals", () => {
        expect(matchWildcard("https://a.example/a+b", "https://a.example/a+b")).toBe(true);
        expect(matchWildcard("https://a.example/a+b", "https://a.example/aab")).toBe(false);
    });

    it("matches many stars in linear time", () => {
        const pattern = `${"*a".repeat(25)}b`;
        const value = `http://x/${"a".repeat(60)}`;
        const started = Date.now();

        expect(matchWildcard(pattern, value)).toBe(false);
        expect(Date.now() - started).toBeLessThan(1000);
    });
});

describe("ruleMatches", () => {
    const rule = (overrides = {}) => ({
        id          : "mock1",
        urlPattern  : "*",
        method      : undefined,
        resourceType: undefined,
        response    : undefined,
        fail        : undefined,
        delayMs     : 0,
        times       : undefined,
        applications: 0,
        errors      : 0,
        createdAt   : "t",
        ...overrides,
    });

    it("checks the pattern, method and resource type in order", () => {
        expect(ruleMatches(rule(), "https://a.example/x", "GET", "XHR")).toBe(true);
        expect(ruleMatches(rule({ method: "post" }), "https://a.example/x", "POST", "XHR")).toBe(true);
        expect(ruleMatches(rule({ method: "POST" }), "https://a.example/x", "GET", "XHR")).toBe(false);
        expect(ruleMatches(rule({ resourceType: "Script" }), "https://a.example/x", "GET", "XHR")).toBe(false);
    });

    it("expires a rule after times applications", () => {
        expect(ruleMatches(rule({ times: 1, applications: 0 }), "u", "GET", "XHR")).toBe(true);
        expect(ruleMatches(rule({ times: 1, applications: 1 }), "u", "GET", "XHR")).toBe(false);
    });
});

describe("headersForCdp", () => {
    it("adds content-type when given and absent", () => {
        expect(headersForCdp({ status: 200, headers: [], bodyBase64: undefined, contentType: "application/json" }))
            .toEqual([{ name: "content-type", value: "application/json" }]);
        expect(headersForCdp({
            status     : 200,
            headers    : [{ name: "Content-Type", value: "text/plain" }],
            bodyBase64 : undefined,
            contentType: "application/json",
        })).toEqual([{ name: "Content-Type", value: "text/plain" }]);
    });
});

describe("InterceptionManager", () => {
    it("enables Fetch once with the union of patterns", async () => {
        const { fake, manager } = interception();

        manager.add("tab1", {
            urlPattern  : "https://a.example/*",
            method      : undefined,
            resourceType: undefined,
            response    : {
                status     : 200,
                headers    : [],
                bodyBase64 : undefined,
                contentType: undefined,
            },
            fail   : undefined,
            delayMs: 0,
            times  : undefined,
        });
        manager.add("tab1", {
            urlPattern  : "https://b.example/*",
            method      : undefined,
            resourceType: undefined,
            response    : undefined,
            fail        : "Failed",
            delayMs     : 0,
            times       : undefined,
        });
        await manager.sync("tab1");
        await manager.sync("tab1");

        expect(manager.enabled("tab1")).toBe(true);

        const order = fake.sent.map((call) => call.method);
        const subscribeIndex = fake.subscribed.findIndex(
            (entry) => entry.targetId === "tab1" && entry.event === "Fetch.requestPaused",
        );

        expect(subscribeIndex).toBe(0);
        expect(order[0]).toBe("Fetch.enable");
        const enables = fake.sent.filter((call) => call.method === "Fetch.enable");

        expect(enables).toHaveLength(2);
        expect(enables[0]?.params).toEqual({
            patterns: [{ urlPattern: "https://a.example/*" }, { urlPattern: "https://b.example/*" }],
        });
        expect(fake.subscribed).toEqual([{ targetId: "tab1", event: "Fetch.requestPaused" }]);
    });

    it("disables when the last rule is removed", async () => {
        const { fake, manager } = interception();

        const rule = manager.add("tab1", {
            urlPattern  : "*",
            method      : undefined,
            resourceType: undefined,
            response    : undefined,
            fail        : "Failed",
            delayMs     : 0,
            times       : undefined,
        });

        await manager.sync("tab1");
        expect(fake.sent.map((call) => call.method)).toContain("Fetch.enable");

        manager.remove("tab1", rule.id);
        await manager.sync("tab1");

        expect(manager.enabled("tab1")).toBe(false);
        expect(fake.sent.map((call) => call.method)).toContain("Fetch.disable");
    });

    it("continues paused requests that match no rule", async () => {
        const { fake, manager } = interception();

        manager.add("tab1", {
            urlPattern  : "https://a.example/*",
            method      : undefined,
            resourceType: undefined,
            response    : {
                status     : 200,
                headers    : [],
                bodyBase64 : undefined,
                contentType: undefined,
            },
            fail   : undefined,
            delayMs: 0,
            times  : undefined,
        });
        await manager.sync("tab1");
        fake.sent.length = 0;

        await manager.handleCdpEvent({
            targetId: "tab1",
            event   : "Fetch.requestPaused",
            params  : {
                requestId   : "req1",
                request     : { url: "https://other.example/x", method: "GET" },
                resourceType: "XHR",
            },
        });

        expect(fake.sent).toEqual([
            { targetId: "tab1", method: "Fetch.continueRequest", params: { requestId: "req1" }, timeoutMs: undefined },
        ]);
    });

    it("fulfills a matching response with headers and base64 body", async () => {
        const { fake, manager } = interception();

        manager.add("tab1", {
            urlPattern  : "https://a.example/api",
            method      : "GET",
            resourceType: undefined,
            response    : {
                status     : 201,
                headers    : [{ name: "x-mock", value: "yes" }],
                bodyBase64 : Buffer.from("hi").toString("base64"),
                contentType: "text/plain",
            },
            fail   : undefined,
            delayMs: 0,
            times  : undefined,
        });
        await manager.sync("tab1");
        fake.sent.length = 0;

        await manager.handleCdpEvent({
            targetId: "tab1",
            event   : "Fetch.requestPaused",
            params  : {
                requestId   : "req2",
                request     : { url: "https://a.example/api", method: "GET" },
                resourceType: "Fetch",
            },
        });

        expect(fake.sent).toEqual([
            {
                targetId: "tab1",
                method  : "Fetch.fulfillRequest",
                params  : {
                    requestId      : "req2",
                    responseCode   : 201,
                    responseHeaders: [
                        { name: "x-mock", value: "yes" },
                        { name: "content-type", value: "text/plain" },
                    ],
                    body: Buffer.from("hi").toString("base64"),
                },
                timeoutMs: undefined,
            },
        ]);
        expect(manager.rulesOf("tab1")[0]?.applications).toBe(1);
    });

    it("fails a matching request and lets the first rule win", async () => {
        const { fake, manager } = interception();

        manager.add("tab1", {
            urlPattern  : "*",
            method      : undefined,
            resourceType: undefined,
            response    : undefined,
            fail        : "BlockedByClient",
            delayMs     : 0,
            times       : undefined,
        });
        manager.add("tab1", {
            urlPattern  : "*",
            method      : undefined,
            resourceType: undefined,
            response    : {
                status     : 200,
                headers    : [],
                bodyBase64 : undefined,
                contentType: undefined,
            },
            fail   : undefined,
            delayMs: 0,
            times  : undefined,
        });
        await manager.sync("tab1");
        fake.sent.length = 0;

        await manager.handleCdpEvent({
            targetId: "tab1",
            event   : "Fetch.requestPaused",
            params  : {
                requestId   : "req3",
                request     : { url: "https://a.example/x", method: "GET" },
                resourceType: "XHR",
            },
        });

        expect(fake.sent).toEqual([
            {
                targetId : "tab1",
                method   : "Fetch.failRequest",
                params   : { requestId: "req3", errorReason: "BlockedByClient" },
                timeoutMs: undefined,
            },
        ]);
    });

    it("expires a times rule and disables on the last one", async () => {
        const { fake, manager } = interception();

        manager.add("tab1", {
            urlPattern  : "*",
            method      : undefined,
            resourceType: undefined,
            response    : {
                status     : 200,
                headers    : [],
                bodyBase64 : undefined,
                contentType: undefined,
            },
            fail   : undefined,
            delayMs: 0,
            times  : 1,
        });
        await manager.sync("tab1");
        fake.sent.length = 0;

        await manager.handleCdpEvent({
            targetId: "tab1",
            event   : "Fetch.requestPaused",
            params  : {
                requestId   : "req4",
                request     : { url: "https://a.example/x", method: "GET" },
                resourceType: "XHR",
            },
        });

        expect(manager.rulesOf("tab1")).toEqual([]);
        expect(fake.sent.map((call) => call.method)).toContain("Fetch.fulfillRequest");
        expect(fake.sent.map((call) => call.method)).toContain("Fetch.disable");
    });

    describe("deferred requests", () => {
        const delayedRule = {
            urlPattern  : "*",
            method      : undefined,
            resourceType: undefined,
            response    : {
                status     : 200,
                headers    : [],
                bodyBase64 : undefined,
                contentType: undefined,
            },
            fail   : undefined,
            delayMs: 60_000,
            times  : undefined,
        };

        async function pausedDelayed() {
            const fake = new FakeAccess();
            const manager = new InterceptionManager({
                access: fake.asAccess(),
                clock : {
                    now  : () => 1_700_000_000_000,
                    sleep: () => new Promise<void>(() => undefined),
                },
            });

            manager.attach();
            manager.add("tab1", delayedRule);
            await manager.sync("tab1");
            fake.sent.length = 0;

            const handled = manager.handleCdpEvent({
                targetId: "tab1",
                event   : "Fetch.requestPaused",
                params  : {
                    requestId   : "slow1",
                    request     : { url: "https://a.example/x", method: "GET" },
                    resourceType: "XHR",
                },
            });

            return { fake, manager, handled };
        }

        const continued = (fake: FakeAccess) => fake.sent
            .filter((call) => call.method === "Fetch.continueRequest")
            .map((call) => call.params);

        it("continues a delayed request when the tab is forgotten", async () => {
            const { fake, manager, handled } = await pausedDelayed();

            await manager.forget("tab1");
            await handled;

            expect(continued(fake)).toEqual([{ requestId: "slow1" }]);
            expect(fake.sent.map((call) => call.method)).not.toContain("Fetch.fulfillRequest");
        });

        it("continues a delayed request when the rules are cleared", async () => {
            const { fake, manager, handled } = await pausedDelayed();

            manager.clear("tab1");
            await manager.sync("tab1");
            await handled;

            expect(continued(fake)).toEqual([{ requestId: "slow1" }]);
            expect(fake.sent.map((call) => call.method)).not.toContain("Fetch.fulfillRequest");
        });

        it("continues a delayed request before Fetch.disable", async () => {
            const { fake, manager, handled } = await pausedDelayed();

            manager.clear("tab1");
            await manager.sync("tab1");
            await handled;

            const methods = fake.sent.map((call) => call.method);

            expect(methods.indexOf("Fetch.continueRequest")).toBeLessThan(methods.indexOf("Fetch.disable"));
        });
    });

    it("continues when the fulfill command fails", async () => {
        const { fake, manager } = interception();

        manager.add("tab1", {
            urlPattern  : "*",
            method      : undefined,
            resourceType: undefined,
            response    : {
                status     : 200,
                headers    : [],
                bodyBase64 : undefined,
                contentType: undefined,
            },
            fail   : undefined,
            delayMs: 0,
            times  : undefined,
        });
        await manager.sync("tab1");
        fake.sent.length = 0;
        fake.failSend = (tab, method) =>
            method === "Fetch.fulfillRequest" ? new Error("boom") : undefined as never;

        await manager.handleCdpEvent({
            targetId: "tab1",
            event   : "Fetch.requestPaused",
            params  : {
                requestId   : "req5",
                request     : { url: "https://a.example/x", method: "GET" },
                resourceType: "XHR",
            },
        });

        expect(fake.sent.map((call) => call.method)).toEqual([
            "Fetch.fulfillRequest",
            "Fetch.continueRequest",
        ]);

        const [rule] = manager.rulesOf("tab1");

        expect(rule?.errors).toBe(1);
        expect((rule?.applications ?? 0) - (rule?.errors ?? 0)).toBe(0);
    });

    it("never applies rules to another tab", async () => {
        const { fake, manager } = interception();

        manager.add("tab1", {
            urlPattern  : "*",
            method      : undefined,
            resourceType: undefined,
            response    : undefined,
            fail        : "Failed",
            delayMs     : 0,
            times       : undefined,
        });
        await manager.sync("tab1");
        fake.sent.length = 0;

        await manager.handleCdpEvent({
            targetId: "tab2",
            event   : "Fetch.requestPaused",
            params  : {
                requestId   : "req6",
                request     : { url: "https://a.example/x", method: "GET" },
                resourceType: "XHR",
            },
        });

        expect(fake.sent).toEqual([
            { targetId: "tab2", method: "Fetch.continueRequest", params: { requestId: "req6" }, timeoutMs: undefined },
        ]);
    });

    it("disables interception on tab close and reset", async () => {
        const { fake, manager } = interception();

        manager.add("tab1", {
            urlPattern  : "*",
            method      : undefined,
            resourceType: undefined,
            response    : undefined,
            fail        : "Failed",
            delayMs     : 0,
            times       : undefined,
        });
        await manager.sync("tab1");
        fake.emit("tab.closed", { targetId: "tab1" });
        await Promise.resolve();
        await manager.reset();

        expect(fake.sent.map((call) => call.method)).toContain("Fetch.disable");
        expect(manager.rulesOf("tab1")).toEqual([]);
    });
});
