import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { browserInfo, newTab, runTool, ToolRuntime } from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const version = {
    protocolVersion: "1.3",
    product        : "Chrome/157.0.1.2",
    revision       : "@abc123",
    userAgent      : "Mozilla/5.0 Chrome/157.0.1.2 Safari/537.36",
    jsVersion      : "15.7.1",
};

async function run(respond: (method: string) => unknown, args: Record<string, unknown> = {}) {
    const fake = new FakeAccess();

    fake.respond = (_tab, method) => respond(method);

    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

    await runTool(newTab, {}, extra(), runtime);

    return { fake, result: await runTool(browserInfo, args, extra(), runtime) };
}

describe("browser_info", () => {
    it("reports the version of the browser and the configured browser and mode", async () => {
        const { fake, result } = await run((method) => (method === "Browser.getVersion" ? version : {}));

        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toEqual({
            tab            : "tab1",
            product        : "Chrome/157.0.1.2",
            revision       : "@abc123",
            userAgent      : version.userAgent,
            jsVersion      : "15.7.1",
            protocolVersion: "1.3",
            browser        : managedConfig.browser,
            mode           : managedConfig.mode,
        });
        expect(fake.sent.some((call) => call.method === "Browser.getVersion")).toBe(true);
    });

    it("says what to do when the browser does not answer in the expected form", async () => {
        const { result } = await run(() => ({ product: 5 }));

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("did not report its version");
    });

    it("needs a tab", async () => {
        const fake = new FakeAccess();
        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });
        const result = await runTool(browserInfo, {}, extra(), runtime);

        expect(result.isError).toBe(true);
    });
});
