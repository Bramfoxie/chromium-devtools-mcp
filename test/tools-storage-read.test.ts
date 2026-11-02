import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
    allTools,
    cookieMatchesUrl,
    pageOrigin,
    runTool,
    storageKeysOf,
    storageOriginOf,
    storageRead,
    ToolRuntime,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

function setup() {
    const fake = new FakeAccess({
        tabs: [
            { targetId: "tab1", url: "https://a.example/page", title: "a", owned: true, created: true },
        ],
    });
    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

    runtime.tabs.refresh(
        [{ targetId: "tab1", url: "https://a.example/page", title: "a", owned: true, created: true }],
        "tab1",
    );

    return { fake, runtime };
}

function textOf(result: Awaited<ReturnType<typeof runTool>>): string {
    return JSON.stringify(result.content);
}

describe("cookie matching", () => {
    const c = (domain: string, path = "/", secure = false) => ({ domain, path, secure });

    it("matches host-only cookies by exact host", () => {
        expect(cookieMatchesUrl(c("a.example"), "https://a.example/x")).toBe(true);
        expect(cookieMatchesUrl(c("a.example"), "https://sub.a.example/x")).toBe(false);
        expect(cookieMatchesUrl(c("b.example"), "https://a.example/x")).toBe(false);
    });

    it("matches domain cookies on subdomains but not on look-alike hosts", () => {
        expect(cookieMatchesUrl(c(".a.example"), "https://a.example/")).toBe(true);
        expect(cookieMatchesUrl(c(".a.example"), "https://sub.a.example/")).toBe(true);
        expect(cookieMatchesUrl(c(".a.example"), "https://nota.example/")).toBe(false);
        expect(cookieMatchesUrl(c(".a.example"), "https://a.example.evil.test/")).toBe(false);
    });

    it("matches paths on segment boundaries", () => {
        expect(cookieMatchesUrl(c("a.example", "/app"), "https://a.example/app")).toBe(true);
        expect(cookieMatchesUrl(c("a.example", "/app"), "https://a.example/app/x")).toBe(true);
        expect(cookieMatchesUrl(c("a.example", "/app"), "https://a.example/apple")).toBe(false);
        expect(cookieMatchesUrl(c("a.example", "/app/"), "https://a.example/app/x")).toBe(true);
        expect(cookieMatchesUrl(c("a.example", "/app"), "https://a.example/")).toBe(false);
    });

    it("keeps secure cookies off insecure pages", () => {
        expect(cookieMatchesUrl(c("a.example", "/", true), "http://a.example/")).toBe(false);
        expect(cookieMatchesUrl(c("a.example", "/", true), "https://a.example/")).toBe(true);
        expect(cookieMatchesUrl(c("localhost", "/", true), "http://localhost:3000/")).toBe(true);
    });
});

describe("storage helpers", () => {
    it("derives the origin from a page URL", () => {
        expect(storageOriginOf("https://a.example:8443/path?q=1")).toBe("https://a.example:8443");
        expect(storageOriginOf("http://localhost:3000/")).toBe("http://localhost:3000");
    });

    it("filters names by the key list", () => {
        expect(storageKeysOf(undefined, ["a", "b"])).toEqual(["a", "b"]);
        expect(storageKeysOf(["b", "missing"], ["a", "b"])).toEqual(["b"]);
    });

    it("reads the page origin through evaluate", async () => {
        const { fake } = setup();

        fake.respond = () => ({ result: { value: "https://a.example/page?x=1" } });
        await expect(pageOrigin(fake.asAccess(), "tab1")).resolves.toBe("https://a.example");
    });
});

describe("opaque origins", () => {
    it("explains that an about:blank page has no storage", async () => {
        const { fake } = setup();

        fake.respond = () => ({ result: { value: "about:blank" } });
        await expect(pageOrigin(fake.asAccess(), "tab1")).rejects.toThrow("opaque origin");
    });
});

describe("storage_read", () => {
    it("flags only the cookie part as dangerous", () => {
        const found = allTools.find((tool) => tool.name === "storage_read");

        expect(found?.access).toBe("read");
        expect(typeof found?.dangerous).toBe("function");

        const dangerous = found?.dangerous as (args: { kind: string }) => boolean;

        expect(dangerous({ kind: "cookies" })).toBe(true);
        expect(dangerous({ kind: "local" })).toBe(false);
        expect(dangerous({ kind: "session" })).toBe(false);
    });

    it("reads local storage through DOMStorage with the origin storage id", async () => {
        const { fake, runtime } = setup();

        fake.respond = (_tab, method) => {
            if (method === "Runtime.evaluate") return { result: { value: "https://a.example/p" } };

            return { entries: [["theme", "dark"], ["lang", "en"]] };
        };

        const result = await runTool(storageRead, { kind: "local" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            tab          : "tab1",
            kind         : "local",
            origin       : "https://a.example",
            count        : 2,
            returned     : 2,
            truncated    : false,
            includeValues: true,
            entries      : [
                { key: "theme", value: "dark", valueSize: 4, truncated: false },
                { key: "lang", value: "en", valueSize: 2, truncated: false },
            ],
        });
        expect(fake.sent.map((call) => call.method)).toEqual([
            "Page.enable",
            "Runtime.evaluate",
            "DOMStorage.enable",
            "DOMStorage.getDOMStorageItems",
        ]);
        expect(fake.sent.at(-1)?.params).toEqual({
            storageId: { securityOrigin: "https://a.example", isLocalStorage: true },
        });
    });

    it("reads session storage with isLocalStorage false", async () => {
        const { fake, runtime } = setup();

        fake.respond = (_tab, method) => {
            if (method === "Runtime.evaluate") return { result: { value: "https://a.example/p" } };

            return { entries: [] };
        };

        await runTool(storageRead, { kind: "session" }, extra(), runtime);

        expect(fake.sent.at(-1)?.params).toEqual({
            storageId: { securityOrigin: "https://a.example", isLocalStorage: false },
        });
    });

    it("filters keys, clips values and marks truncation", async () => {
        const { fake, runtime } = setup();

        fake.respond = (_tab, method) => {
            if (method === "Runtime.evaluate") return { result: { value: "https://a.example/p" } };

            return { entries: [["a", "x".repeat(10)], ["b", "y"], ["c", "z"]] };
        };

        const result = await runTool(
            storageRead,
            { kind: "local", keys: ["a", "b", "c"], maxEntries: 2, maxValueChars: 4 },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({
            count    : 3,
            returned : 2,
            truncated: true,
            entries  : [
                { key: "a", valueSize: 10, truncated: true },
                { key: "b", value: "y", truncated: false },
            ],
        });
        expect(String(JSON.stringify(result.structuredContent))).toContain("[truncated:");
    });

    it("omits values when includeValues is false", async () => {
        const { fake, runtime } = setup();

        fake.respond = (_tab, method) => {
            if (method === "Runtime.evaluate") return { result: { value: "https://a.example/p" } };

            return { entries: [["k", "secret"]] };
        };

        const result = await runTool(
            storageRead,
            { kind: "local", includeValues: false },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({
            includeValues: false,
            entries      : [{ key: "k", valueSize: 6, truncated: false }],
        });
        expect(JSON.stringify(result.structuredContent)).not.toContain("secret");
    });

    it("reads cookies without the urls parameter and hides values by default", async () => {
        const { fake, runtime } = setup();

        fake.respond = (_tab, method) => {
            if (method === "Runtime.evaluate") return { result: { value: "https://a.example/p" } };

            if (method === "Network.getCookies") {
                return {
                    cookies: [
                        {
                            name    : "sid",
                            value   : "top-secret",
                            domain  : "a.example",
                            path    : "/",
                            expires : -1,
                            size    : 12,
                            httpOnly: true,
                            secure  : true,
                            session : true,
                            sameSite: "Lax",
                        },
                    ],
                };
            }

            throw new Error(`unexpected ${method}`);
        };

        const result = await runTool(storageRead, { kind: "cookies" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            kind         : "cookies",
            count        : 1,
            includeValues: false,
            cookies      : [
                { name: "sid", domain: "a.example", httpOnly: true, secure: true, sameSite: "Lax" },
            ],
        });
        expect(JSON.stringify(result.structuredContent)).not.toContain("top-secret");
        expect(fake.sent.map((call) => call.method)).not.toContain("Network.getAllCookies");
        const cookiesCall = fake.sent.find((call) => call.method === "Network.getCookies");

        expect(cookiesCall?.params).toBeUndefined();
    });

    it("excludes cookies of other origins and counts only matching ones", async () => {
        const { fake, runtime } = setup();
        const cookie = (name: string, domain: string, path = "/", secure = false) => ({
            name,
            value   : "v",
            domain,
            path,
            expires : -1,
            size    : 2,
            httpOnly: false,
            secure,
            session : true,
        });

        fake.respond = (_tab, method) => {
            if (method === "Runtime.evaluate") return { result: { value: "https://a.example/page" } };

            return {
                cookies: [
                    cookie("own", "a.example"),
                    cookie("shared", ".example.test"),
                    cookie("tracker", ".ads.test"),
                    cookie("other", "b.example"),
                    cookie("elsewhere", "a.example", "/admin"),
                ],
            };
        };

        const result = await runTool(storageRead, { kind: "cookies" }, extra(), runtime);
        const names = (result.structuredContent as { cookies: { name: string }[] }).cookies.map(
            (entry) => entry.name,
        );

        expect(names).toEqual(["own"]);
        expect(result.structuredContent).toMatchObject({ count: 1, returned: 1 });
    });

    it("returns cookie values only with includeValues", async () => {
        const { fake, runtime } = setup();

        fake.respond = (_tab, method) => {
            if (method === "Runtime.evaluate") return { result: { value: "https://a.example/p" } };

            return {
                cookies: [
                    {
                        name    : "sid",
                        value   : "v".repeat(20),
                        domain  : "a.example",
                        path    : "/",
                        expires : 999,
                        size    : 24,
                        httpOnly: false,
                        secure  : false,
                        session : false,
                    },
                ],
            };
        };

        const result = await runTool(
            storageRead,
            { kind: "cookies", includeValues: true, maxValueChars: 5 },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({
            cookies: [{ name: "sid", truncated: true }],
        });
        expect(String(JSON.stringify(result.structuredContent))).toContain("[truncated:");
    });

    it("rejects keys for cookies", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(storageRead, { kind: "cookies", keys: ["a"] }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("keys only applies");
        expect(fake.sent).toEqual([]);
    });

    it("fails fast while a dialog is open", async () => {
        const { fake, runtime } = setup();

        runtime.dialogs.handleCdpEvent({
            targetId: "tab1",
            event   : "Page.javascriptDialogOpening",
            params  : { url: "https://a.example/", message: "stop", type: "alert" },
        });

        const result = await runTool(storageRead, { kind: "local" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("page_dialogs");
        expect(fake.sent.map((call) => call.method)).toEqual(["Page.enable"]);
    });
});
