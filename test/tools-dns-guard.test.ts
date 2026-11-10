import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { newTab, pageNavigate, runTool, ToolRuntime } from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const guarded = (patch: Partial<Config["safety"]> = {}): Config => ({
    ...managedConfig,
    safety: { ...managedConfig.safety, allowPrivateNetworks: false, ...patch },
});

function setup(config: Config, resolve: (host: string) => Promise<string[]>) {
    const asked: string[] = [];
    const fake = new FakeAccess();
    const runtime = new ToolRuntime({
        access     : fake.asAccess(),
        config,
        resolveHost: async (host) => {
            asked.push(host);

            return resolve(host);
        },
    });

    return { fake, runtime, asked };
}

const text = (result: { content: unknown }) => JSON.stringify(result.content);

describe("a public name that resolves to a private address", () => {
    it("is refused by new_tab before any tab is opened", async () => {
        const { fake, runtime, asked } = setup(guarded(), async () => ["127.0.0.1"]);
        const result = await runTool(newTab, { url: "https://rebind.example/" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("rebind.example");
        expect(text(result)).toContain("resolves to a local or private network address");
        expect(asked).toEqual(["rebind.example"]);
        expect(fake.tabs).toHaveLength(0);
    });

    it("is refused by page_navigate", async () => {
        const { fake, runtime } = setup(guarded(), async () => ["10.1.2.3"]);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(pageNavigate, { url: "https://rebind.example/x" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("resolves to a local or private network address");
        expect(fake.sent.some((call) => call.method === "Page.navigate")).toBe(false);
    });

    it("is refused when one of several addresses is private", async () => {
        const { runtime } = setup(guarded(), async () => ["93.184.216.34", "192.168.0.9"]);
        const result = await runTool(newTab, { url: "https://mixed.example/" }, extra(), runtime);

        expect(result.isError).toBe(true);
    });
});

describe("a name that is fine", () => {
    it("opens when every address is public", async () => {
        const { runtime, asked } = setup(guarded(), async () => ["93.184.216.34"]);
        const result = await runTool(newTab, { url: "https://example.com/", timeoutMs: 1 }, extra(), runtime);

        expect(result.isError).toBeUndefined();
        expect(asked[0]).toBe("example.com");
    });

    it("opens when the name does not resolve, so the navigation fails on its own", async () => {
        const { runtime } = setup(guarded(), async () => []);
        const result = await runTool(newTab, { url: "https://nowhere.example/", timeoutMs: 1 }, extra(), runtime);

        expect(result.isError).toBeUndefined();
    });

    it("is not looked up when private networks are allowed or the owner named the host", async () => {
        const open = setup(guarded({ allowPrivateNetworks: true }), async () => ["127.0.0.1"]);
        const named = setup(
            guarded({ allowedDomains: ["dev.example.com"] }),
            async () => ["127.0.0.1"],
        );

        await runTool(newTab, { url: "https://rebind.example/", timeoutMs: 1 }, extra(), open.runtime);
        await runTool(newTab, { url: "https://dev.example.com/", timeoutMs: 1 }, extra(), named.runtime);

        expect(open.asked).toEqual([]);
        expect(named.asked).toEqual([]);
    });
});

describe("a lookup that fails", () => {
    it("refuses the navigation when the lookup times out or errors", async () => {
        const { runtime, fake } = setup(guarded(), async () => {
            throw new Error("lookup timed out");
        });
        const result = await runTool(newTab, { url: "https://slow.example/" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("could not be resolved");
        expect(fake.tabs).toHaveLength(0);
    });
});

describe("the address a navigation ended on", () => {
    it("is parked on about:blank when its name resolves to a private address", async () => {
        const fake = new FakeAccess();
        const answers = new Map([
            ["start.example", ["93.184.216.34"]],
            ["landing.example", ["127.0.0.1"]],
        ]);
        const runtime = new ToolRuntime({
            access     : fake.asAccess(),
            config     : guarded(),
            resolveHost: async (host) => answers.get(host) ?? [],
        });

        fake.respond = (_tab, method) =>
            method === "Runtime.evaluate"
                ? {
                    result: {
                        type : "object",
                        value: { url: "https://landing.example/page", title: "t", readyState: "complete" },
                    },
                }
                : {};

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(
            pageNavigate,
            { url: "https://start.example/", waitUntil: "none" },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("landing.example");
        expect(text(result)).toContain("moved to about:blank");
        expect(fake.sent.at(-1)).toMatchObject({ method: "Page.navigate", params: { url: "about:blank" } });
    });
});
