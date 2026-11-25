import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/stop", html("<title>Stop test</title>"));
});

afterAll(async () => {
    await env?.stop();
});

describe.skipIf(!present)("stopping page loading in a real browser", () => {
    it("interrupts a pending resource request", async () => {
        let requested = false;
        let closed = false;
        const server = createServer((_request, response) => {
            requested = true;
            response.writeHead(200, { "content-type": "image/png" });
            response.write("pending");
            response.on("close", () => { closed = true; });
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();

        if (address === null || typeof address === "string") throw new Error("No fixture port");

        env.fixture.pages.set("/loading", html(`<img src="http://127.0.0.1:${address.port}/slow">`));
        const tab = await env.open("/stop");

        try {
            await env.ok("page_navigate", { tab, url: `${env.fixture.origin}/loading`, waitUntil: "none" });
            await vi.waitFor(() => expect(requested).toBe(true), { timeout: 5000 });
            expect(closed).toBe(false);
            await env.ok("page_navigate", { tab, action: "stop" });
            await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5000 });
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("accepts the stop command for a tab", async () => {
        const tab = await env.open("/stop");
        const result = await env.ok("page_navigate", { tab, action: "stop" });

        expect(result).toMatchObject({ tab, navigationType: "stop", waited: "none" });
    });
});
