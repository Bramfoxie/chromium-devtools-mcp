import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

type Row = Record<string, unknown>;

const EDIT_PAGE = `<div id="card" class="box" title="old" style="font-size: 14px">hello <b>world</b></div>
<div id="gone">bye</div>
<div id="host"></div>
<iframe id="same" src="/edit-inner"></iframe>
<script>
document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
  '<p id="deep" class="note">shadow text</p>';
</script>`;

const INNER = `<p id="inner" class="note">inner text</p>`;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/edit", html(EDIT_PAGE));
    env.fixture.pages.set("/edit-inner", html(INNER));
    env.other.pages.set("/edit-cross", html(`<p id="cross">cross text</p>`));
    env.fixture.pages.set(
        "/edit-xframe",
        html(`<iframe name="cross" src="${env.other.origin}/edit-cross"></iframe>`),
    );
});

afterAll(async () => {
    await env?.stop();
});

async function read(tab: string, expression: string): Promise<unknown> {
    const result = (await env.ok("js_evaluate", { tab, expression })) as { value?: unknown };

    return result.value;
}

async function frameIdOf(tab: string, urlEnd: string): Promise<string> {
    const snap = (await env.ok("dom_snapshot", { tab })) as { frames: Row[] };
    const found = snap.frames.find((frame) => String(frame.url).endsWith(urlEnd));

    return String(found?.frameId);
}

describe.skipIf(!present)("dom_edit in a real browser", () => {
    it("edits attributes, text and classes and reports the previous value", async () => {
        const tab = await env.open("/edit");

        const set = await env.ok("dom_edit", {
            tab,
            target: { selector: "#card" },
            action: "set_attribute",
            name  : "title",
            value : "new",
        });

        expect(set).toMatchObject({ ok: true, attribute: "title", previous: "old" });
        expect(await read(tab, "document.getElementById('card').getAttribute('title')")).toBe("new");

        const removed = await env.ok("dom_edit", {
            tab,
            target: { selector: "#card" },
            action: "remove_attribute",
            name  : "title",
        });

        expect(removed).toMatchObject({ ok: true, previous: "new" });
        expect(await read(tab, "document.getElementById('card').hasAttribute('title')")).toBe(false);

        const text = await env.ok("dom_edit", {
            tab,
            target: { selector: "#card" },
            action: "set_text",
            text  : "plain",
        });

        expect(String((text as { previous?: unknown }).previous)).toContain("hello");
        expect(await read(tab, "document.getElementById('card').textContent")).toBe("plain");

        const added = await env.ok("dom_edit", {
            tab,
            target   : { selector: "#card" },
            action   : "add_class",
            className: "on",
        });

        expect(added).toMatchObject({ ok: true, had: false, has: true });
        expect(await read(tab, "document.getElementById('card').className")).toContain("on");

        const toggled = await env.ok("dom_edit", {
            tab,
            target   : { selector: "#card" },
            action   : "toggle_class",
            className: "on",
        });

        expect(toggled).toMatchObject({ ok: true, had: true, has: false });
    });

    it("replaces HTML and removes an element", async () => {
        const tab = await env.open("/edit");

        const set = await env.ok("dom_edit", {
            tab,
            target: { selector: "#card" },
            action: "set_html",
            html  : "<i id=\"fresh\">new</i>",
        });

        expect(String((set as { previous?: unknown }).previous)).toContain("world");
        expect(await read(tab, "document.getElementById('fresh')?.textContent ?? null")).toBe("new");

        const removed = await env.ok("dom_edit", {
            tab,
            target: { selector: "#gone" },
            action: "remove",
        });

        expect(String((removed as { previous?: unknown }).previous)).toContain("bye");
        expect(await read(tab, "document.getElementById('gone')")).toBe(null);
        expect(await read(tab, "document.querySelectorAll('style[data-cdm]').length")).toBe(0);
    });

    it("edits elements in shadow DOM and in same-process iframes", async () => {
        const tab = await env.open("/edit");

        await env.ok("dom_edit", {
            tab,
            target: { selector: "#host >>> #deep" },
            action: "set_text",
            text  : "shadow edited",
        });
        expect(await read(tab, "document.getElementById('host').shadowRoot.getElementById('deep').textContent"))
            .toBe("shadow edited");

        await env.ok("dom_edit", {
            tab,
            target   : { selector: "#deep", pierce: true },
            action   : "add_class",
            className: "pierced",
        });
        expect(await read(tab, "document.getElementById('host').shadowRoot.getElementById('deep').className"))
            .toContain("pierced");

        const frame = await frameIdOf(tab, "/edit-inner");

        await env.ok("dom_edit", {
            tab,
            target: { selector: "#inner", frame },
            action: "set_text",
            text  : "frame edited",
        });
        expect(await read(tab, `document.querySelector("iframe").contentDocument.getElementById("inner").textContent`))
            .toBe("frame edited");
    });

    it("edits an element by uid and refuses a stale one", async () => {
        const tab = await env.open("/edit");
        const query = (await env.ok("dom_query", { tab, selector: "#card" })) as { matches: Row[] };
        const uid = String(query.matches[0]?.uid);

        await env.ok("dom_edit", { tab, target: { uid }, action: "set_text", text: "by uid" });
        expect(await read(tab, "document.getElementById('card').textContent")).toBe("by uid");

        await env.ok("page_navigate", { tab, url: `${env.fixture.origin}/edit-inner` });

        const stale = await env.call("dom_edit", { tab, target: { uid }, action: "set_text", text: "x" });

        expect(stale.isError).toBe(true);
        expect(stale.text).toContain("stale");
    });

    it("edits an element in a cross-site frame", async () => {
        const tab = await env.open("/edit-xframe");
        const frame = await frameIdOf(tab, "/edit-cross");

        await env.ok("dom_edit", {
            tab,
            target: { selector: "#cross", frame },
            action: "set_text",
            text  : "cross edited",
        });

        const seen = await env.ok("dom_query", { tab, selector: "#cross", frame, attributes: [] });

        expect(JSON.stringify(seen)).toContain("cross edited");
    });

    it("refuses bad input without touching the page", async () => {
        const tab = await env.open("/edit");
        const bad = await env.call("dom_edit", {
            tab,
            target: { selector: "#card" },
            action: "set_attribute",
            name  : "bad name",
            value : "x",
        });

        expect(bad.isError).toBe(true);
        expect(bad.text).toContain("Attribute names");

        const missing = await env.call("dom_edit", {
            tab,
            target: { selector: "#card" },
            action: "set_text",
        });

        expect(missing.isError).toBe(true);
        expect(missing.text).toContain("needs text");
    });
});
