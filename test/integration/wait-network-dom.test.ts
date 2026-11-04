import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

interface Waited {
    met      : boolean;
    elapsedMs: number;
    detail   : { status?: number; url?: string; mutations?: number };
}

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set(
        "/dyn",
        html(`<div id="box"></div>
<script>
window.__fire = (path) => fetch(path).catch(() => undefined);
window.__churn = (times, every) => {
  let n = 0;
  const timer = setInterval(() => {
    document.getElementById("box").textContent = String(n);
    n += 1;
    if (n >= times) clearInterval(timer);
  }, every);
};
</script>`),
    );
    env.fixture.pages.set("/api/data", { body: '{"ok":1}', status: 200, type: "application/json" });
    env.fixture.pages.set("/api/bad", { body: "no", status: 404, type: "text/plain" });
});

afterAll(async () => {
    await env?.stop();
});

const evaluate = (tab: string, expression: string) => env.ok("js_evaluate", { tab, expression });

const wait = async (tab: string, args: Record<string, unknown>) =>
    (await env.ok("page_wait", { tab, ...args })) as unknown as Waited;

describe.skipIf(!present)("waiting for a response in a real browser", () => {
    it("returns when a matching response arrives after the call starts", async () => {
        const tab = await env.open("/dyn");

        await env.ok("network_requests", { tab });
        await evaluate(tab, "setTimeout(() => window.__fire('/api/data?x=1'), 400); 1");

        const result = await wait(tab, { responseUrl: "/api/data", timeoutMs: 10_000 });

        expect(result.met).toBe(true);
        expect(result.detail.status).toBe(200);
        expect(result.detail.url).toContain("/api/data");
        expect(result.elapsedMs).toBeGreaterThanOrEqual(300);
    });

    it("can require a status and match by regular expression", async () => {
        const tab = await env.open("/dyn");

        await env.ok("network_requests", { tab });
        await evaluate(tab, "setTimeout(() => { window.__fire('/api/data'); window.__fire('/api/bad'); }, 300); 1");

        const result = await wait(tab, { responseUrlRegex: "/api/.*", responseStatus: 404, timeoutMs: 10_000 });

        expect(result.met).toBe(true);
        expect(result.detail.status).toBe(404);
        expect(result.detail.url).toContain("/api/bad");
    });

    it("is not met when nothing matching arrives, and ignores earlier responses unless asked", async () => {
        const tab = await env.open("/dyn");

        await env.ok("network_requests", { tab });
        await evaluate(tab, "window.__fire('/api/data'); 1");
        await new Promise((resolve) => setTimeout(resolve, 600));

        const missed = await wait(tab, { responseUrl: "/api/data", timeoutMs: 700 });
        const earlier = await wait(tab, { responseUrl: "/api/data", includePrevious: true, timeoutMs: 700 });
        const never = await wait(tab, { responseUrl: "/api/never", includePrevious: true, timeoutMs: 500 });

        expect(missed.met).toBe(false);
        expect(earlier.met).toBe(true);
        expect(never.met).toBe(false);
    });

    it("refuses responseStatus and includePrevious without a response condition", async () => {
        const tab = await env.open("/dyn");
        const status = await env.call("page_wait", { tab, ms: 5, responseStatus: 200 });
        const previous = await env.call("page_wait", { tab, ms: 5, includePrevious: true });

        expect(status.isError).toBe(true);
        expect(previous.isError).toBe(true);
    });
});

describe.skipIf(!present)("waiting for a quiet document in a real browser", () => {
    it("waits until the changes stop", async () => {
        const tab = await env.open("/dyn");

        await evaluate(tab, "window.__churn(8, 100); 1");

        const result = await wait(tab, { domQuietMs: 300, timeoutMs: 10_000 });

        expect(result.met).toBe(true);
        expect(result.elapsedMs).toBeGreaterThanOrEqual(900);
        expect(result.detail.mutations).toBeGreaterThan(0);
    });

    it("is not met while the document keeps changing", async () => {
        const tab = await env.open("/dyn");

        await evaluate(tab, "window.__churn(100, 50); 1");

        const result = await wait(tab, { domQuietMs: 400, timeoutMs: 800 });

        expect(result.met).toBe(false);
    });

    it("is met at once on a document that does not change", async () => {
        const tab = await env.open("/dyn");
        const result = await wait(tab, { domQuietMs: 200, timeoutMs: 5000 });

        expect(result.met).toBe(true);
        expect(result.elapsedMs).toBeLessThan(2000);
    });
});
