import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

const PAGE = `<h1>Checkout</h1>
<label for="email">Email address</label><input id="email" placeholder="you@example.com">
<input id="phone" aria-label="Phone number">
<button id="save1">Save</button><button id="save2">Save draft</button>
<button id="ghost" style="display:none">Save hidden</button>
<a id="home" href="#home">Home page</a>
<p id="msg">Order <b id="b">confirmed</b> today</p>
<p id="dup">same words</p><p id="dup2">same words</p>
<div id="host"></div>
<iframe id="frame" src="/loc-inner"></iframe>
<script>
document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
  '<button id="deep">Deep action</button>';
</script>`;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/loc", html(PAGE));
    env.fixture.pages.set("/loc-inner", html(`<button id="inner">Inner action</button>`));
});

afterAll(async () => {
    await env?.stop();
});

async function clearHits(tab: string): Promise<void> {
    await env.ok("js_evaluate", {
        tab,
        expression:
            `(function clear(root) { for (const el of root.querySelectorAll('[data-hit]')) el.removeAttribute('data-hit'); ` +
            `for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) clear(el.shadowRoot); ` +
            `if (el.tagName === 'IFRAME' && el.contentDocument) clear(el.contentDocument); } })(document)`,
    });
}

async function hit(tab: string, target: Record<string, unknown>): Promise<unknown> {
    await clearHits(tab);
    await env.ok("dom_edit", {
        tab,
        target,
        action: "set_attribute",
        name  : "data-hit",
        value : "1",
    });
    const result = (await env.ok("js_evaluate", {
        tab,
        expression:
            `(function find(root) { for (const el of root.querySelectorAll('*')) { ` +
            `if (el.getAttribute('data-hit') === '1') return el.id; ` +
            `if (el.shadowRoot) { const r = find(el.shadowRoot); if (r) return r; } ` +
            `if (el.tagName === 'IFRAME' && el.contentDocument) { const r = find(el.contentDocument); if (r) return r; } } ` +
            `return null; })(document)`,
    })) as { value?: unknown };

    return result.value;
}

describe.skipIf(!present)("locators in a real browser", () => {
    it("finds an element by role and an accessible name, also from a label or a placeholder", async () => {
        const tab = await env.open("/loc");

        expect(await hit(tab, { locator: { role: "heading", name: "checkout" } })).toBe("");
        expect(await hit(tab, { locator: { role: "link", name: "Home" } })).toBe("home");
        expect(await hit(tab, { locator: { role: "textbox", name: "Email" } })).toBe("email");
        expect(await hit(tab, { locator: { role: "textbox", name: "Phone number", exact: true } }))
            .toBe("phone");
    });

    it("tells apart a name by part and an exact name, and refuses several matches", async () => {
        const tab = await env.open("/loc");
        const several = await env.call("dom_edit", {
            tab,
            target: { locator: { role: "button", name: "Save" } },
            action: "set_attribute",
            name  : "data-hit",
            value : "1",
        });

        expect(several.isError).toBe(true);
        expect(several.text).toContain("2 elements have");
        expect(several.text).toContain("nth (0 to 1)");
        expect(await hit(tab, { locator: { role: "button", name: "Save", exact: true } })).toBe("save1");
        expect(await hit(tab, { locator: { role: "button", name: "Save", nth: 1 } })).toBe("save2");
    });

    it("does not see an element that is not in the accessibility tree", async () => {
        const tab = await env.open("/loc");
        const hidden = await env.call("dom_edit", {
            tab,
            target: { locator: { role: "button", name: "hidden" } },
            action: "set_attribute",
            name  : "data-hit",
            value : "1",
        });

        expect(hidden.isError).toBe(true);
        expect(hidden.text).toContain("No element has the role");
    });

    it("finds an element by its visible text, the smallest one, and refuses a repeated text", async () => {
        const tab = await env.open("/loc");

        expect(await hit(tab, { locator: { text: "confirmed" } })).toBe("b");
        expect(await hit(tab, { locator: { text: "Order", exact: false } })).toBe("msg");

        const repeated = await env.call("dom_edit", {
            tab,
            target: { locator: { text: "same words" } },
            action: "set_attribute",
            name  : "data-hit",
            value : "1",
        });

        expect(repeated.isError).toBe(true);
        expect(repeated.text).toContain("2 elements have the visible text");
        expect(await hit(tab, { locator: { text: "same words", nth: 1 } })).toBe("dup2");
    });

    it("sees through an open shadow root and searches a chosen frame", async () => {
        const tab = await env.open("/loc");

        expect(await hit(tab, { locator: { role: "button", name: "Deep action" } })).toBe("deep");
        expect(await hit(tab, { locator: { text: "Deep action" } })).toBe("deep");

        const frame = (await env.ok("dom_snapshot", { tab })) as {
            frames: Array<{ frameId: string; url: string }>;
        };
        const inner = frame.frames.find((entry) => entry.url.endsWith("/loc-inner"))?.frameId;

        expect(await hit(tab, { locator: { role: "button", name: "Inner" }, frame: inner })).toBe("inner");
    });

    it("works with the input tools the way a selector does", async () => {
        const tab = await env.open("/loc");

        await env.ok("input_type", {
            tab,
            target: { locator: { role: "textbox", name: "Email address" } },
            text  : "a@b.test",
        });
        const value = (await env.ok("js_evaluate", {
            tab,
            expression: "document.getElementById('email').value",
        })) as { value?: unknown };

        expect(value.value).toBe("a@b.test");
    });
});
