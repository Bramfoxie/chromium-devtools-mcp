import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, eventually, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

type Row = Record<string, unknown>;

const PAGES: Record<string, string> = {
    "/main": `<button id="btn" onclick="window.clicks=(window.clicks||0)+1"><span id="inner">go</span></button>
<input id="field"><p class="line">hello world</p><p class="line">hello again</p><div id="host"></div>
<script>window.evals=0;
const root=document.getElementById("host").attachShadow({mode:"open"});
root.innerHTML='<button class="deep" onclick="window.deepClicks=(window.deepClicks||0)+1">deep</button>';</script>`,
    "/deep"    : `${"<section aria-label=s>".repeat(80)}<button>bottom</button>${"</section>".repeat(80)}`,
    "/frames"  : '<iframe id="one" name="first" src="/other"></iframe><iframe id="two" src="/cookie"></iframe>',
    "/other"   : "<h1>other</h1>",
    "/tall"    : '<div style="height:100000px">tall</div><span id="end">end</span>',
    "/form"    : '<form action="/other" method="get"><input id="q" name="q"></form>',
    "/jump"    : '<a id="go" href="/other" onclick="location.href=\'/other\';return false">go</a>',
    "/scrolled": '<div style="height:900px"></div><div id="box" style="width:120px;height:80px;background:#c00">box</div><div style="height:900px"></div>',
    "/cookie"  : "<p>cookie</p>",
    "/data"    : "{\"from\":\"server\"}",
    "/fetcher" : "<p>fetch</p>",
    "/waiter"  : '<script>setTimeout(()=>{document.body.insertAdjacentHTML("beforeend","<i id=late>late</i>")},300)</script>',
};

async function evaluate(expression: string, tab?: string): Promise<unknown> {
    return (await env.ok("js_evaluate", { expression, ...(tab ? { tab } : {}) })).value;
}

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();

    for (const [route, body] of Object.entries(PAGES)) {
        env.fixture.pages.set(route, route === "/data" ? { body, status: 200, type: "application/json" } : html(body));
    }
}, 60_000);

afterAll(async () => {
    await env?.stop();
}, 60_000);

describe.skipIf(!present)("real browser", () => {
    it("js_evaluate returns structured values and evaluates once", async () => {
        await env.open("/main");
        const result = await env.ok("js_evaluate", { expression: "({ a: 1, list: [1, 2] })" });

        expect(result).toMatchObject({ ok: true, type: "object", value: { a: 1, list: [1, 2] } });
        await env.ok("js_evaluate", { expression: "window.evals += 1" });
        expect(await evaluate("window.evals")).toBe(1);
    });

    it("js_evaluate accepts a repeated top level declaration and still evaluates once", async () => {
        await env.open("/main");
        await env.ok("js_evaluate", { expression: "const repeated = 1; window.evals += 1" });
        const second = await env.ok("js_evaluate", { expression: "const repeated = 2; repeated" });

        expect(second).toMatchObject({ ok: true, value: 2 });
        expect(await evaluate("window.evals")).toBe(1);
        expect(await evaluate("({ a: 1 })")).toEqual({ a: 1 });
    });

    it("js_evaluate stops a blocking alert at timeoutMs", async () => {
        const tab = await env.open("/other");
        const started = Date.now();
        const outcome = await env.call("js_evaluate", { expression: "alert(1)", timeoutMs: 1000, tab });

        expect(outcome.isError).toBe(true);
        expect(outcome.text).toContain("1000 ms");
        expect(Date.now() - started).toBeLessThan(10_000);
        await env.ok("page_dialogs", { action: "dismiss", tab });
    });

    it("page_navigate waits for load and reports the status", async () => {
        await env.open("/main");
        const result = await env.ok("page_navigate", { url: `${env.fixture.origin}/other` });

        expect(result).toMatchObject({ waited: "load", status: 200 });
    });

    it("page_navigate reports a download and an empty response without waiting", async () => {
        const tab = await env.open("/other");

        env.fixture.pages.set("/file", {
            body   : "payload",
            status : 200,
            type   : "application/octet-stream",
            headers: { "content-disposition": "attachment; filename=a.bin" },
        });
        env.fixture.pages.set("/empty", { body: "", status: 204, type: "text/plain" });

        const expected = { "/file": "file download", "/empty": "aborted" };

        for (const route of ["/file", "/empty"] as const) {
            const started = Date.now();
            const outcome = await env.call("page_navigate", {
                url      : `${env.fixture.origin}${route}`,
                timeoutMs: 20_000,
                tab,
            });

            expect(Date.now() - started).toBeLessThan(8000);
            expect(outcome.isError).toBe(true);
            expect(outcome.text).toContain(expected[route]);
        }

        expect(await evaluate("location.pathname", tab)).toBe("/other");
    });

    it("page_navigate to a fragment of the current page finishes promptly", async () => {
        const tab = await env.open("/other");
        const started = Date.now();
        const result = await env.ok("page_navigate", {
            url      : `${env.fixture.origin}/other#part`,
            timeoutMs: 20_000,
            tab,
        });

        expect(Date.now() - started).toBeLessThan(8000);
        expect(result).toMatchObject({ waited: "load", url: `${env.fixture.origin}/other#part` });
    });

    it("a page initiated navigation invalidates old uids", async () => {
        await env.open("/jump");
        const found = await env.ok("dom_query", { selector: "#go" });
        const uid = (found.matches as Row[])[0]?.uid;

        expect(typeof uid).toBe("string");
        await env.ok("click", { target: { selector: "#go" } });
        await eventually(async () => String(await evaluate("location.pathname")) === "/other");
        const stale = await env.call("input_click", { target: { uid } });

        expect(stale.isError).toBe(true);
        expect(stale.text).toMatch(/uid|snapshot|query/i);
    });

    it("dom_query pierce returns uids that work for input and counts text matches", async () => {
        await env.open("/main");
        const pierced = await env.ok("dom_query", { selector: ".deep", pierce: true, all: true });
        const deep = (pierced.matches as Row[])[0];

        expect(pierced.matches as Row[]).toHaveLength(1);
        expect(pierced).toMatchObject({ total: 1, returned: 1, truncated: false });
        await env.ok("input_click", { target: { uid: deep?.uid } });
        expect(await evaluate("window.deepClicks")).toBe(1);

        const texts = await env.ok("dom_query", { selector: "p", text: "hello", all: true });

        expect(texts).toMatchObject({ total: 2, returned: 2 });
        const shadow = await env.ok("dom_query", { selector: "#host >>> .deep" });

        expect((shadow.matches as Row[]).length).toBe(1);
    });

    it("dom_query uids of a text filtered match point at the matched element", async () => {
        await env.open("/main");
        const found = await env.ok("dom_query", { selector: "p", text: "again", all: true });
        const uid = (found.matches as Row[])[0]?.uid;
        const read = await env.ok("js_evaluate", {
            expression: "(el) => el.textContent",
            target    : { uid },
        });

        expect(found).toMatchObject({ total: 2, returned: 1 });
        expect(read).toMatchObject({ ok: true, value: "hello again" });
    });

    it("dom_snapshot marks a tree deeper than its accessibility depth cap", async () => {
        await env.open("/deep");
        const snap = await env.ok("dom_snapshot", {});

        expect(snap.truncated).toBe(true);
        expect(String(snap.snapshot)).toContain("accessibility tree has more than");
    });

    it("a frame selector matching several iframes lists them and one iframe still works", async () => {
        await env.open("/frames");
        const ambiguous = await env.call("dom_query", { selector: "h1", frame: "iframe" });

        expect(ambiguous.isError).toBe(true);
        expect(ambiguous.text).toContain("matches 2 iframes");
        expect(ambiguous.text).toContain('id="two"');
        expect(ambiguous.text).toContain("frame id from dom_snapshot");

        const single = await eventually(async () => {
            const read = await env.ok("dom_query", { selector: "h1", frame: "#one" });

            return (read.matches as Row[]).length > 0 ? read : undefined;
        });

        expect(single.matches as Row[]).toHaveLength(1);
        await env.ok("click", { target: { selector: "h1", frame: "#one" } });
    });

    it("input_click works on a button with a nested span", async () => {
        await env.open("/main");
        await env.ok("input_click", { target: { selector: "#inner" } });
        await env.ok("input_click", { target: { selector: "#btn" } });
        expect(await evaluate("window.clicks")).toBe(2);
    });

    it("input_scroll to the bottom reaches maxY of a very tall page", async () => {
        await env.open("/tall");
        await env.ok("input_scroll", { to: "bottom" });
        const info = await eventually(async () => {
            const page = await env.ok("page_info");
            const scroll = page.scroll as { y: number; maxY: number };

            return scroll.maxY > 50_000 && scroll.y >= scroll.maxY - 1 ? scroll : undefined;
        });

        expect(info.maxY).toBeGreaterThan(90_000);
    });

    it("input_type with submit that navigates returns ok", async () => {
        await env.open("/form");
        const result = await env.ok("input_type", { target: { selector: "#q" }, text: "abc", submit: true });

        expect(result).toBeDefined();
        await eventually(async () => String(await evaluate("location.search")) === "?q=abc");
    });

    it("console_logs and network_requests capture lazily from the first call", async () => {
        const tab = await env.open("/other");

        await evaluate("console.log('first-message')", tab);
        await env.ok("network_requests", { tab });
        await env.ok("console_logs", { tab });
        await evaluate("console.log('second-message'); fetch('/data')", tab);
        const logs = await eventually(async () => {
            const read = await env.ok("console_logs", { tab, textContains: "second-message" });

            return (read.entries as Row[]).length > 0 ? read : undefined;
        });
        const requests = await eventually(async () => {
            const read = await env.ok("network_requests", { tab, urlContains: "/data" });

            return (read.requests as Row[]).length > 0 ? read : undefined;
        });

        expect((logs.entries as Row[])[0]?.text).toContain("second-message");
        expect((requests.requests as Row[])[0]).toMatchObject({ status: 200 });
    });

    it("page_wait handles selectors, network idle and invalid selectors", async () => {
        const tab = await env.open("/waiter");
        const late = await env.ok("page_wait", { selector: "#late", tab });

        expect(late.met).toBe(true);
        const idle = await env.ok("page_wait", { loadState: "networkidle", tab });
        const detail = idle.detail as { idleMs: number };

        expect(idle.met).toBe(true);
        expect(detail.idleMs).toBeGreaterThanOrEqual(400);
        expect(detail.idleMs).toBeLessThan(5000);
        const invalid = await env.call("page_wait", { selector: "##", tab });

        expect(invalid.isError).toBe(true);
        expect(invalid.text).toContain("not a valid selector");
    });

    it("storage_read cookies stay on the page origin and DOM storage round trips", async () => {
        const tab = await env.open("/cookie");
        const cookies = await env.ok("storage_read", { kind: "cookies", tab });

        expect(cookies.origin).toBe(env.fixture.origin);
        expect((cookies.cookies as Row[]).map((cookie) => cookie.name)).toEqual(["fixture"]);
        await env.ok("storage_write", { kind: "local", action: "set", entries: { key: "value" }, tab });
        const local = await env.ok("storage_read", { kind: "local", tab });

        expect(local.entries).toMatchObject([{ key: "key", value: "value" }]);
        expect(await evaluate("localStorage.getItem('key')", tab)).toBe("value");
        await env.ok("storage_write", { kind: "local", action: "remove", keys: ["key"], tab });
        expect(await evaluate("localStorage.getItem('key')", tab)).toBeNull();
    });

    it("network_mock serves the mocked body until the rules are cleared", async () => {
        const tab = await env.open("/fetcher");
        const fetchBody = () => evaluate("fetch('/data').then((r) => r.text())", tab);

        await env.ok("network_mock", {
            tab,
            action: "add",
            rule  : { urlPattern: "*/data", response: { status: 200, body: "mocked", contentType: "text/plain" } },
        });
        expect(await fetchBody()).toBe("mocked");
        const listed = await env.ok("network_mock", { tab, action: "list" });

        expect((listed.rules as Row[])[0]).toMatchObject({ kind: "response", applications: 1 });
        await env.ok("network_mock", { tab, action: "clear" });
        expect(await fetchBody()).toBe('{"from":"server"}');
        expect((await env.ok("network_mock", { tab, action: "list" })).rules).toEqual([]);
    });

    it("page_dialogs catches an alert and dismisses it", async () => {
        const tab = await env.open("/other");
        const idle = await env.ok("page_dialogs", { tab });

        expect(idle.open).toBeNull();
        await evaluate("setTimeout(() => alert('hi'), 20); 1", tab);
        const open = await eventually(async () => {
            const status = await env.ok("page_dialogs", { tab });

            return status.open ? status : undefined;
        });

        expect(open.open).toMatchObject({ type: "alert", message: "hi" });
        const closed = await env.ok("page_dialogs", { tab, action: "dismiss" });

        expect(closed.open).toBeNull();
        expect(closed.history).toMatchObject([{ type: "alert", resolved: "dismiss" }]);
    });

    it("emulate_network offline blocks fetches until reset", async () => {
        const tab = await env.open("/fetcher");
        const attempt = () => evaluate("fetch('/data').then(() => 'ok', () => 'failed')", tab);

        await env.ok("emulate_network", { tab, preset: "offline" });
        expect(await attempt()).toBe("failed");
        await env.ok("emulate_network", { tab, reset: true });
        expect(await attempt()).toBe("ok");
    });

    it("emulate_media and emulate_locale apply and reset", async () => {
        const tab = await env.open("/other");
        const dark = () => evaluate("matchMedia('(prefers-color-scheme: dark)').matches", tab);

        await env.ok("emulate_media", { tab, colorScheme: "dark" });
        expect(await dark()).toBe(true);
        await env.ok("emulate_media", { tab, reset: true });
        expect(await dark()).toBe(false);
        const before = await evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone", tab);

        await env.ok("emulate_locale", { tab, timezone: "Asia/Tokyo" });
        expect(await evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone", tab)).toBe("Asia/Tokyo");
        await env.ok("emulate_locale", { tab, reset: true });
        expect(await evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone", tab)).toBe(before);
    });

    it("screenshot of an element on a scrolled page has the element size and fullPage honors scale", async () => {
        const tab = await env.open("/scrolled");

        await env.ok("input_scroll", { tab, to: "bottom" });
        const element = await env.call("screenshot", { tab, target: { selector: "#box" }, format: "png" });
        const image = element.blocks.find((block) => block.type === "image") as { data: string } | undefined;

        expect(element.isError).toBe(false);
        expect(pngSize(image?.data)).toEqual({ width: 120, height: 80 });
        const full = await env.call("screenshot", { tab, fullPage: true, format: "png", scale: 0.5 });
        const fullImage = full.blocks.find((block) => block.type === "image") as { data: string } | undefined;
        const size = pngSize(fullImage?.data);

        expect(size.height).toBeGreaterThan(800);
        expect(size.height).toBeLessThan(1000);
    });
});

function pngSize(data: string | undefined): { width: number; height: number } {
    const bytes = Buffer.from(data ?? "", "base64");

    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
