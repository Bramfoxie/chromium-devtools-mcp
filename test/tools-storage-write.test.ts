import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import {
    allTools,
    cookieDomainAllowed,
    runTool,
    storageWrite,
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

describe("cookieDomainAllowed", () => {
    it("accepts the host and its parent domains", () => {
        expect(cookieDomainAllowed(undefined, "shop.a.example")).toBe(true);
        expect(cookieDomainAllowed("shop.a.example", "shop.a.example")).toBe(true);
        expect(cookieDomainAllowed("a.example", "shop.a.example")).toBe(true);
        expect(cookieDomainAllowed(".a.example", "shop.a.example")).toBe(true);
    });

    it("ignores case", () => {
        expect(cookieDomainAllowed("A.EXAMPLE", "shop.a.example")).toBe(true);
        expect(cookieDomainAllowed("a.example", "SHOP.A.EXAMPLE")).toBe(true);
    });

    it("rejects foreign domains and bare labels", () => {
        expect(cookieDomainAllowed("other.example", "shop.a.example")).toBe(false);
        expect(cookieDomainAllowed("example", "shop.a.example")).toBe(false);
        expect(cookieDomainAllowed("com", "shop.a.example")).toBe(false);
        expect(cookieDomainAllowed("", "shop.a.example")).toBe(false);
        expect(cookieDomainAllowed("notshop.a.example", "shop.a.example")).toBe(false);
    });

    it("rejects suffix tricks without a dot boundary", () => {
        expect(cookieDomainAllowed("xshop.a.example", "shop.a.example")).toBe(false);
        expect(cookieDomainAllowed("ample", "example")).toBe(false);
    });

    it("only matches IP hosts exactly", () => {
        expect(cookieDomainAllowed("127.0.0.1", "127.0.0.1")).toBe(true);
        expect(cookieDomainAllowed("0.0.1", "127.0.0.1")).toBe(false);
        expect(cookieDomainAllowed(undefined, "10.0.0.5")).toBe(true);
        expect(cookieDomainAllowed("::1", "::1")).toBe(true);
        expect(cookieDomainAllowed("1", "::1")).toBe(false);
    });
});

describe("storage_write", () => {
    it("is a dangerous mutate tool", () => {
        const found = allTools.find((tool) => tool.name === "storage_write");

        expect(found?.access).toBe("mutate");
        expect(found?.dangerous).toBe(true);
    });

    it("sets local storage entries without echoing values", async () => {
        const { fake, runtime } = setup();

        fake.respond = (tab, method) => {
            if (method === "Runtime.evaluate") return { result: { value: "https://a.example/p" } };
            if (method === "DOMStorage.getDOMStorageItems") return { entries: [["k", "v"]] };

            return {};
        };

        const result = await runTool(
            storageWrite,
            { kind: "local", action: "set", entries: { theme: "dark-secret" } },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            tab      : "tab1",
            kind     : "local",
            action   : "set",
            origin   : "https://a.example",
            changed  : 1,
            remaining: 1,
        });
        expect(JSON.stringify(result.structuredContent)).not.toContain("dark-secret");
        expect(fake.sent.at(1)).toMatchObject({ method: "DOMStorage.enable" });
        expect(fake.sent.at(2)).toMatchObject({
            method: "DOMStorage.setDOMStorageItem",
            params: {
                storageId: { securityOrigin: "https://a.example", isLocalStorage: true },
                key      : "theme",
                value    : "dark-secret",
            },
        });
    });

    it("removes session entries", async () => {
        const { fake, runtime } = setup();

        fake.respond = (tab, method) => {
            if (method === "Runtime.evaluate") return { result: { value: "https://a.example/p" } };
            if (method === "DOMStorage.getDOMStorageItems") return { entries: [] };

            return {};
        };

        const result = await runTool(
            storageWrite,
            { kind: "session", action: "remove", keys: ["a", "b"] },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({ changed: 2, remaining: 0 });
        expect(fake.sent.filter((call) => call.method === "DOMStorage.removeDOMStorageItem"))
            .toHaveLength(2);
    });

    it("refuses clear without confirm", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(
            storageWrite,
            { kind: "local", action: "clear" },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("confirm: true");
        expect(fake.sent.map((call) => call.method)).not.toContain("DOMStorage.clear");
    });

    it("clears with confirm and reports the count", async () => {
        const { fake, runtime } = setup();

        fake.respond = (tab, method) => {
            if (method === "Runtime.evaluate") return { result: { value: "https://a.example/p" } };

            if (method === "DOMStorage.getDOMStorageItems") {
                return { entries: [["a", "1"], ["b", "2"]] };
            }

            return {};
        };

        const result = await runTool(
            storageWrite,
            { kind: "local", action: "clear", confirm: true },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({ changed: 2, remaining: 0 });
        expect(fake.sent.map((call) => call.method)).toContain("DOMStorage.clear");
    });

    it("sets cookies with the page URL and matching domains", async () => {
        const { fake, runtime } = setup();

        fake.respond = (tab, method) => {
            if (method === "Runtime.evaluate") return { result: { value: "https://a.example/p" } };
            if (method === "Network.setCookie") return { success: true };
            if (method === "Network.getCookies") return { cookies: [] };

            return {};
        };

        const result = await runTool(
            storageWrite,
            {
                kind   : "cookies",
                action : "set",
                cookies: [{ name: "sid", value: "secret", domain: "a.example", secure: true }],
            },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(JSON.stringify(result.structuredContent)).not.toContain("secret");
        expect(fake.sent.find((call) => call.method === "Network.setCookie")?.params)
            .toMatchObject({ name: "sid", value: "secret", url: "https://a.example/page", domain: "a.example" });
    });

    it("refuses a foreign cookie domain", async () => {
        const { fake, runtime } = setup();

        fake.respond = (tab, method) => {
            if (method === "Runtime.evaluate") return { result: { value: "https://a.example/p" } };

            return {};
        };

        const result = await runTool(
            storageWrite,
            { kind: "cookies", action: "set", cookies: [{ name: "x", value: "1", domain: "evil.example" }] },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("outside the page host");
        expect(fake.sent.map((call) => call.method)).not.toContain("Network.setCookie");
    });

    it("reports a browser cookie refusal", async () => {
        const { fake, runtime } = setup();

        fake.respond = (tab, method) => {
            if (method === "Runtime.evaluate") return { result: { value: "https://a.example/p" } };
            if (method === "Network.setCookie") return { success: false };

            return {};
        };

        const result = await runTool(
            storageWrite,
            { kind: "cookies", action: "set", cookies: [{ name: "x", value: "1" }] },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("was refused by the browser");
    });

    it("removes cookies with the page URL", async () => {
        const { fake, runtime } = setup();

        fake.respond = (tab, method) => {
            if (method === "Runtime.evaluate") return { result: { value: "https://a.example/p" } };
            if (method === "Network.getCookies") return { cookies: [] };

            return {};
        };

        const result = await runTool(
            storageWrite,
            { kind: "cookies", action: "remove", remove: [{ name: "sid" }] },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({ changed: 1 });
        expect(fake.sent.find((call) => call.method === "Network.deleteCookies")?.params)
            .toMatchObject({ name: "sid", url: "https://a.example/page" });
    });

    it("clears cookies one by one with confirm", async () => {
        const { fake, runtime } = setup();
        let calls = 0;

        fake.respond = (tab, method) => {
            if (method === "Runtime.evaluate") return { result: { value: "https://a.example/p" } };

            if (method === "Network.getCookies") {
                calls += 1;

                return calls <= 2
                    ? {
                        cookies: [
                            { name: "a", domain: "a.example", path: "/" },
                            { name: "b", domain: "a.example", path: "/" },
                        ],
                    }
                    : { cookies: [] };
            }

            return {};
        };

        const refused = await runTool(
            storageWrite,
            { kind: "cookies", action: "clear" },
            extra(),
            runtime,
        );

        expect(refused.isError).toBe(true);
        expect(textOf(refused)).toContain("confirm: true");

        const cleared = await runTool(
            storageWrite,
            { kind: "cookies", action: "clear", confirm: true },
            extra(),
            runtime,
        );

        expect(cleared.structuredContent).toMatchObject({ changed: 2, remaining: 0 });
        expect(fake.sent.filter((call) => call.method === "Network.deleteCookies")).toHaveLength(2);
    });

    it("rejects storage fields for cookies and cookie fields for storage", async () => {
        const { runtime } = setup();

        const first = await runTool(
            storageWrite,
            { kind: "cookies", action: "set", entries: { a: "b" } },
            extra(),
            runtime,
        );

        expect(first.isError).toBe(true);
        expect(textOf(first)).toContain("not to cookies");

        const second = await runTool(
            storageWrite,
            { kind: "local", action: "set", cookies: [{ name: "a", value: "b" }] },
            extra(),
            runtime,
        );

        expect(second.isError).toBe(true);
        expect(textOf(second)).toContain("only apply to kind cookies");
    });

    it("is refused in read-only mode", async () => {
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

        const result = await runTool(
            storageWrite,
            { kind: "local", action: "clear", confirm: true },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("read-only mode");
        expect(fake.sent).toEqual([]);
    });
});
