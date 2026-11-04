import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

interface Made {
    selector: string;
    unique  : boolean;
    frame?  : string;
    locator?: { role: string; name: string; exact?: boolean; nth?: number };
}

const PAGE = `<nav><a id="home" href="#">Home</a></nav>
<main>
  <button data-testid="save-btn">Save</button>
  <button class="btn css-a1b2c3 primary">Save draft</button>
  <ul><li>one</li><li>two</li><li>three</li></ul>
  <p class="note">first</p><p class="note">second</p>
  <div id="dup">a</div><div id="dup">b</div>
  <div id="host"></div>
  <iframe id="frame" src="/sel-inner"></iframe>
</main>
<script>
document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
  '<section><button class="deep">Deep</button><button class="deep2">Deep two</button></section>';
</script>`;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/sel", html(PAGE));
    env.fixture.pages.set("/sel-inner", html(`<button id="inner">Inner</button>`));
});

afterAll(async () => {
    await env?.stop();
});

const make = async (tab: string, target: Record<string, unknown>) =>
    (await env.ok("dom_selector", { tab, target })) as unknown as Made;

async function resolvesTo(
    tab     : string,
    made    : Made,
    expected: string,
): Promise<void> {
    await env.ok("js_evaluate", {
        tab,
        expression:
            "document.querySelectorAll('[data-found]').forEach((el) => el.removeAttribute('data-found'))",
    });
    await env.ok("dom_edit", {
        tab,
        target: {
            selector: made.selector,
            ...(made.frame === undefined ? {} : { frame: made.frame }),
        },
        action: "set_attribute",
        name  : "data-found",
        value : "1",
    });

    const found = (await env.ok("js_evaluate", {
        tab,
        expression:
            `(function find(root) { for (const el of root.querySelectorAll('*')) { ` +
            `if (el.getAttribute('data-found') === '1') return el.textContent.trim().slice(0, 20) || el.id; ` +
            `if (el.shadowRoot) { const r = find(el.shadowRoot); if (r) return r; } ` +
            `if (el.tagName === 'IFRAME' && el.contentDocument) { const r = find(el.contentDocument); if (r) return r; } } ` +
            `return null; })(document)`,
    })) as { value?: unknown };

    expect(found.value).toBe(expected);
}

describe.skipIf(!present)("dom_selector in a real browser", () => {
    it("prefers an id, then a test attribute, then a stable class", async () => {
        const tab = await env.open("/sel");
        const byId = await make(tab, { selector: "#home" });
        const byAttr = await make(tab, { locator: { role: "button", name: "Save", exact: true } });
        const byClass = await make(tab, { locator: { role: "button", name: "Save draft" } });

        expect(byId).toMatchObject({ selector: "#home", unique: true });
        expect(byAttr.selector).toBe('button[data-testid="save-btn"]');
        expect(byClass.selector).toMatch(/^button\.(btn|primary)$|^button\.btn\.primary$/);
        expect(byClass.selector).not.toContain("css-a1b2c3");
        await resolvesTo(tab, byId, "Home");
        await resolvesTo(tab, byAttr, "Save");
        await resolvesTo(tab, byClass, "Save draft");
    });

    it("builds a path with positions when nothing short is unique, and finds the element again", async () => {
        const tab = await env.open("/sel");
        const second = await make(tab, { selector: "li:nth-of-type(2)" });
        const note = await make(tab, { selector: ".note:nth-of-type(2)" });

        expect(second.unique).toBe(true);
        expect(second.selector).toContain(":nth-of-type(2)");
        expect(note.unique).toBe(true);
        await resolvesTo(tab, second, "two");
        await resolvesTo(tab, note, "second");
    });

    it("does not rely on a duplicated id", async () => {
        const tab = await env.open("/sel");
        const made = await make(tab, { selector: "main > div:nth-of-type(2)" });

        expect(made.unique).toBe(true);
        expect(made.selector).not.toBe("#dup");
    });

    it("chains a shadow host and the selector inside its shadow root", async () => {
        const tab = await env.open("/sel");
        const made = await make(tab, { selector: "#host >>> .deep2" });

        expect(made.selector).toContain(" >>> ");
        expect(made.unique).toBe(true);
        await resolvesTo(tab, made, "Deep two");
    });

    it("names the iframe of an element in a frame so the selector can be used with it", async () => {
        const tab = await env.open("/sel");
        const frames = (await env.ok("dom_snapshot", { tab })) as {
            frames: Array<{ frameId: string; url: string }>;
        };
        const inner = frames.frames.find((frame) => frame.url.endsWith("/sel-inner"))?.frameId;
        const made = await make(tab, { selector: "#inner", frame: inner });

        expect(made.selector).toBe("#inner");
        expect(made.frame).toBe("#frame");
        await resolvesTo(tab, made, "Inner");
    });

    it("gives a locator that finds the element again, with exact when the name is not enough", async () => {
        const tab = await env.open("/sel");
        const save = await make(tab, { selector: 'button[data-testid="save-btn"]' });
        const draft = await make(tab, { locator: { role: "button", name: "Save draft" } });
        const unnamed = await make(tab, { selector: "ul" });

        expect(save.locator).toEqual({ role: "button", name: "Save", exact: true });
        expect(draft.locator).toEqual({ role: "button", name: "Save draft" });
        expect(unnamed.locator).toBeUndefined();

        await env.ok("dom_edit", {
            tab,
            target: { locator: save.locator },
            action: "set_attribute",
            name  : "title",
            value : "found",
        });

        const title = (await env.ok("js_evaluate", {
            tab,
            expression: "document.querySelector('[data-testid=save-btn]').title",
        })) as { value?: unknown };

        expect(title.value).toBe("found");
    });
});
