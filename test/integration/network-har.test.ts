import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

interface Entry {
    startedDateTime: string;
    request        : { url: string };
    response       : { status: number; content: { mimeType: string } };
}

interface Saved {
    tab    : string;
    file   : { path: string; bytes: number };
    entries: number;
}

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set(
        "/har",
        html(`<img src="/pixel.png"><script>
fetch("/api?user=1&token=abc123").then(() => fetch("/missing"));
</script>`),
    );
    env.fixture.pages.set("/api", { body: '{"ok":true}', status: 200, type: "application/json" });
    env.fixture.pages.set("/pixel.png", { body: new Uint8Array([1, 2, 3]), status: 200, type: "image/png" });
});

afterAll(async () => {
    await env?.stop();
});

describe.skipIf(!present)("network_har in a real browser", () => {
    it("saves the requests of a tab as a HAR file with redacted secrets", async () => {
        const tab = await env.open("/har");

        await env.ok("network_requests", { tab });
        await env.ok("page_navigate", { tab, action: "reload" });
        await new Promise((resolve) => setTimeout(resolve, 800));

        const saved = (await env.ok("network_har", { tab })) as unknown as Saved;
        const text = await readFile(saved.file.path, "utf8");
        const har = JSON.parse(text) as { log: { version: string; entries: Entry[] } };
        const urls = har.log.entries.map((entry) => String(entry.request.url));

        expect(har.log.version).toBe("1.2");
        expect(saved.entries).toBe(har.log.entries.length);
        expect(saved.file.path.startsWith(env.artifactsDir)).toBe(true);
        expect(urls.some((url) => url.endsWith("/har"))).toBe(true);
        expect(urls.some((url) => url.includes("/api?user=1"))).toBe(true);
        expect(text).not.toContain("abc123");
        expect(text).toContain("[redacted]");

        const api = har.log.entries.find((entry) => String(entry.request.url).includes("/api"));

        expect(api?.response.status).toBe(200);
        expect(api?.response.content.mimeType).toContain("json");
        expect(typeof api?.startedDateTime).toBe("string");
        expect(Number.isNaN(Date.parse(String(api?.startedDateTime)))).toBe(false);
    });

    it("keeps only the requests that match the filter and empties the buffer on request", async () => {
        const tab = await env.open("/har");

        await env.ok("network_requests", { tab });
        await env.ok("page_navigate", { tab, action: "reload" });
        await new Promise((resolve) => setTimeout(resolve, 800));

        const failing = (await env.ok("network_har", {
            tab,
            statusMin: 400,
            clear    : true,
        })) as unknown as Saved;
        const har = JSON.parse(await readFile(failing.file.path, "utf8")) as {
            log: { entries: Entry[] };
        };

        expect(har.log.entries.length).toBeGreaterThan(0);
        expect(har.log.entries.every((entry) => Number(entry.response.status) >= 400)).toBe(true);

        const after = (await env.ok("network_requests", { tab })) as { totalBuffered: number };

        expect(after.totalBuffered).toBe(0);
    });
});
