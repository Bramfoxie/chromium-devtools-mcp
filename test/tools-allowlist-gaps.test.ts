import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { networkMock, runTool, storageRead, ToolRuntime } from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const withSafety = (patch: Partial<Config["safety"]>): Config => ({
    ...managedConfig,
    safety: { ...managedConfig.safety, ...patch },
});

function setup(config: Config, href = "https://a.example/") {
    const fake = new FakeAccess({
        tabs: [{ targetId: "tab1", url: href, title: "t", owned: true, created: true }],
    });

    fake.respond = (_tab, method) => {
        if (method === "Runtime.evaluate") return { result: { value: href } };

        if (method === "Network.getCookies") return { cookies: [] };

        return {};
    };

    const runtime = new ToolRuntime({ access: fake.asAccess(), config });

    runtime.attach();
    runtime.tabs.select("tab1");

    return { fake, runtime };
}

const rule = (urlPattern: string) => ({
    action: "add" as const,
    rule  : { urlPattern, response: { status: 200, body: "x" } },
});

const text = (result: { content: unknown }) => JSON.stringify(result.content);

describe("network_mock patterns under domain rules", () => {
    const allow = withSafety({ allowedDomains: ["a.example", "*.cdn.example"] });

    it("adds a rule for an allowed host", async () => {
        const { runtime } = setup(allow);
        const result = await runTool(networkMock, rule("https://a.example/api/*"), extra(), runtime);

        expect(result.isError).not.toBe(true);
    });

    it("refuses a rule for a host outside the allowed list and names it", async () => {
        const { runtime } = setup(allow);
        const result = await runTool(networkMock, rule("https://evil.test/*"), extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("evil.test");
        expect(text(result)).toContain("safety.allowedDomains");
        expect(runtime.mock.rulesOf("tab1")).toEqual([]);
    });

    it("refuses a pattern that names no host, and one that could reach any host", async () => {
        const { runtime } = setup(allow);

        for (const urlPattern of ["*", "https://*/*", "**/api"]) {
            const result = await runTool(networkMock, rule(urlPattern), extra(), runtime);

            expect(result.isError, urlPattern).toBe(true);
            expect(text(result)).toContain("name its host");
        }
    });

    it("refuses a denied host even when no allowed list is set", async () => {
        const { runtime } = setup(withSafety({ deniedDomains: ["bad.test"] }));
        const refused = await runTool(networkMock, rule("https://bad.test/*"), extra(), runtime);
        const fine = await runTool(networkMock, rule("https://good.test/*"), extra(), runtime);

        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain("safety.deniedDomains");
        expect(fine.isError).not.toBe(true);
    });

    it("keeps accepting any pattern when no domain rule is set", async () => {
        const { runtime } = setup(managedConfig);
        const result = await runTool(networkMock, rule("*"), extra(), runtime);

        expect(result.isError).not.toBe(true);
    });
});

describe("cookie reads under domain rules", () => {
    it("reads the cookies of a page inside the allowed list", async () => {
        const { runtime } = setup(withSafety({ allowedDomains: ["a.example"] }));
        const result = await runTool(storageRead, { kind: "cookies" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
    });

    it("refuses the cookies of a page outside the list or on a denied host, before asking the browser", async () => {
        const outside = setup(withSafety({ allowedDomains: ["a.example"] }), "https://evil.test/");
        const denied = setup(withSafety({ deniedDomains: ["evil.test"] }), "https://evil.test/");

        for (const { fake, runtime } of [outside, denied]) {
            const result = await runTool(storageRead, { kind: "cookies" }, extra(), runtime);

            expect(result.isError).toBe(true);
            expect(text(result)).toContain("evil.test");
            expect(fake.sent.map((call) => call.method)).not.toContain("Network.getCookies");
        }
    });

    it("still reads local storage of such a page, which only cookies are guarded against", async () => {
        const { fake, runtime } = setup(
            withSafety({ allowedDomains: ["a.example"] }),
            "https://evil.test/",
        );

        fake.respond = (_tab, method) => method === "Runtime.evaluate"
            ? { result: { value: "https://evil.test/" } }
            : {};

        const result = await runTool(storageRead, { kind: "local" }, extra(), runtime);

        expect(text(result)).not.toContain("outside safety.allowedDomains");
    });
});
