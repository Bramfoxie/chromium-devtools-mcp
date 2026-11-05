import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, eventually, html, startEnv, type Env } from "./browser-env.js";

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

    it("gives a revertible previous for set_text on markup and a position for remove", async () => {
        const tab = await env.open("/edit");
        const text = (await env.ok("dom_edit", {
            tab,
            target: { selector: "#card" },
            action: "set_text",
            text  : "plain",
        })) as { previous?: string; previousIsHtml?: boolean };

        expect(text).toMatchObject({ previous: "hello <b>world</b>", previousIsHtml: true });

        const before = await read(
            tab,
            "Array.prototype.indexOf.call(document.body.childNodes, document.getElementById('gone'))",
        );
        const removed = (await env.ok("dom_edit", {
            tab,
            target: { selector: "#gone" },
            action: "remove",
        })) as { index?: number };

        expect(removed.index).toBe(before);
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

describe.skipIf(!present)("css_edit in a real browser", () => {
    it("edits inline styles and reports previous and computed values", async () => {
        const tab = await env.open("/edit");

        const result = (await env.ok("css_edit", {
            tab,
            target      : { selector: "#card" },
            action      : "set_style",
            declarations: { color: "rgb(255, 0, 0)" },
        })) as { previous?: Record<string, string>; computed?: Record<string, string> };

        expect(result.previous).toEqual({ color: "" });
        expect(result.computed?.color).toContain("255, 0, 0");
        expect(await read(tab, "document.getElementById('card').style.color")).toBe("rgb(255, 0, 0)");

        const cleared = (await env.ok("css_edit", {
            tab,
            target      : { selector: "#card" },
            action      : "set_style",
            declarations: { color: "" },
        })) as { previous?: Record<string, string> };

        expect(cleared.previous).toEqual({ color: "rgb(255, 0, 0)" });
        expect(await read(tab, "document.getElementById('card').style.color")).toBe("");
    });

    it("adds and removes a rule in a tagged style element", async () => {
        const tab = await env.open("/edit");

        expect(await read(tab, "document.querySelectorAll('style[data-cdm]').length")).toBe(0);

        const added = (await env.ok("css_edit", {
            tab,
            target      : { selector: "#card" },
            action      : "add_rule",
            selector    : "#card",
            declarations: { color: "rgb(0, 0, 255)" },
        })) as { ruleId?: string; selector?: string };

        expect(typeof added.ruleId).toBe("string");
        expect(added.selector).toBe("#card");
        expect(await read(tab, "document.querySelectorAll('style[data-cdm]').length")).toBe(1);
        expect(await read(tab, "getComputedStyle(document.getElementById('card')).color")).toContain("0, 0, 255");

        const again = (await env.ok("css_edit", {
            tab,
            target      : { selector: "#card" },
            action      : "add_rule",
            selector    : "#gone",
            declarations: { color: "rgb(0, 128, 0)" },
        })) as { ruleId?: string };

        expect(again.ruleId).not.toBe(added.ruleId);
        expect(await read(tab, "document.querySelectorAll('style[data-cdm]').length")).toBe(1);

        await env.ok("css_edit", { tab, target: { selector: "#card" }, action: "remove_rule", ruleId: added.ruleId });
        expect(await read(tab, "getComputedStyle(document.getElementById('card')).color")).not.toContain("0, 0, 255");
        expect(await read(tab, "document.querySelectorAll('style[data-cdm]').length")).toBe(1);

        await env.ok("css_edit", { tab, target: { selector: "#card" }, action: "remove_rule", ruleId: again.ruleId });
        expect(await read(tab, "document.querySelectorAll('style[data-cdm]').length")).toBe(0);

        const missing = await env.call("css_edit", {
            tab,
            target: { selector: "#card" },
            action: "remove_rule",
            ruleId: "99",
        });

        expect(missing.isError).toBe(false);
        expect(missing.text).toContain("already have been removed");
    });

    it("edits styles in shadow DOM and in same-process iframes", async () => {
        const tab = await env.open("/edit");

        const shadow = (await env.ok("css_edit", {
            tab,
            target      : { selector: "#host >>> #deep" },
            action      : "set_style",
            declarations: { color: "rgb(255, 0, 0)" },
        })) as { computed?: Record<string, string> };

        expect(shadow.computed?.color).toContain("255, 0, 0");

        const frame = await frameIdOf(tab, "/edit-inner");
        const framed = (await env.ok("css_edit", {
            tab,
            target      : { selector: "#inner", frame },
            action      : "set_style",
            declarations: { color: "rgb(0, 0, 255)" },
        })) as { computed?: Record<string, string> };

        expect(framed.computed?.color).toContain("0, 0, 255");
        expect(await read(tab, `getComputedStyle(document.querySelector("iframe").contentDocument.getElementById("inner")).color`))
            .toContain("0, 0, 255");

        await env.ok("css_edit", {
            tab,
            target      : { selector: "#inner", frame },
            action      : "add_rule",
            selector    : "#inner",
            declarations: { color: "rgb(0, 128, 0)" },
        });
        expect(await read(tab, `document.querySelector("iframe").contentDocument.querySelectorAll("style[data-cdm]").length`))
            .toBe(1);
        expect(await read(tab, "document.querySelectorAll('style[data-cdm]').length")).toBe(0);
    });

    it("leaves nothing behind for a rule that is not a style rule or has a bad declaration", async () => {
        const tab = await env.open("/edit");
        const sheets = "document.querySelectorAll('style[data-cdm]').length";

        for (const selector of ["@media print", "@font-face", "a {} b"]) {
            const refused = await env.call("css_edit", {
                tab,
                target      : { selector: "#card" },
                action      : "add_rule",
                selector,
                declarations: { color: "red" },
            });

            expect(refused.isError).toBe(true);
            expect(refused.text).toContain("not a style rule selector");
        }

        const bad = await env.call("css_edit", {
            tab,
            target      : { selector: "#card" },
            action      : "add_rule",
            selector    : "#card",
            declarations: { colr: "red" },
        });

        expect(bad.isError).toBe(true);
        expect(bad.text).toContain("did not accept colr");
        expect(await read(tab, sheets)).toBe(0);
    });

    it("accepts a selector with a brace in a string and reports the declarations the browser kept", async () => {
        const tab = await env.open("/edit");
        const added = (await env.ok("css_edit", {
            tab,
            target      : { selector: "#card" },
            action      : "add_rule",
            selector    : '#card[title="{"], #card',
            declarations: { color: "rgb(1, 2, 3)", "Margin-Top": "4px !important" },
        })) as { declarations?: Record<string, string> };

        expect(added.declarations).toEqual({ color: "rgb(1, 2, 3)", "margin-top": "4px !important" });
        expect(await read(tab, "getComputedStyle(document.getElementById('card')).color")).toContain("1, 2, 3");
    });

    it("keeps the priority in previous and refuses an unknown property without a change", async () => {
        const tab = await env.open("/edit");

        await read(tab, "document.getElementById('card').style.setProperty('color', 'red', 'important')");

        const edited = (await env.ok("css_edit", {
            tab,
            target      : { selector: "#card" },
            action      : "set_style",
            declarations: { color: "blue" },
        })) as { previous?: Record<string, string> };

        expect(edited.previous).toEqual({ color: "red !important" });

        const unknown = await env.call("css_edit", {
            tab,
            target      : { selector: "#card" },
            action      : "set_style",
            declarations: { "font-size": "20px", foo: "bar" },
        });

        expect(unknown.isError).toBe(true);
        expect(unknown.text).toContain("did not accept foo");
        expect(await read(tab, "document.getElementById('card').style.fontSize")).toBe("14px");
    });

    it("does not reuse a style tag of the page and puts a rule of a shadow target into its root", async () => {
        const tab = await env.open("/edit");

        await read(
            tab,
            `document.head.insertAdjacentHTML("beforeend", '<style data-cdm>#gone { color: rgb(9, 9, 9) }</style>')`,
        );

        const added = (await env.ok("css_edit", {
            tab,
            target      : { selector: "#host >>> #deep" },
            action      : "add_rule",
            selector    : "#deep",
            declarations: { color: "rgb(0, 0, 255)" },
        })) as { ruleId?: string };

        expect(await read(tab, "document.getElementById('host').shadowRoot.querySelectorAll('style').length")).toBe(1);
        expect(await read(tab, "getComputedStyle(document.getElementById('host').shadowRoot.getElementById('deep')).color"))
            .toContain("0, 0, 255");

        await env.ok("css_edit", { tab, target: { selector: "#host >>> #deep" }, action: "remove_rule", ruleId: added.ruleId });

        expect(await read(tab, "document.getElementById('host').shadowRoot.querySelectorAll('style').length")).toBe(0);
        expect(await read(tab, "document.querySelectorAll('style[data-cdm]').length")).toBe(1);
        expect(await read(tab, "getComputedStyle(document.getElementById('gone')).color")).toContain("9, 9, 9");

        const forged = await env.ok("css_edit", {
            tab,
            target: { selector: "#card" },
            action: "remove_rule",
            ruleId: "cdm-forged",
        });

        expect(forged).toMatchObject({ ok: false });
        expect(await read(tab, "document.querySelectorAll('style[data-cdm]').length")).toBe(1);
    });

    it("rejects an invalid selector and bad property names", async () => {
        const tab = await env.open("/edit");

        const bad = await env.call("css_edit", {
            tab,
            target      : { selector: "#card" },
            action      : "add_rule",
            selector    : "???",
            declarations: { color: "red" },
        });

        expect(bad.isError).toBe(true);
        expect(bad.text).toContain("not a style rule selector");
        expect(await read(tab, "document.querySelectorAll('style[data-cdm]').length")).toBe(0);

        const property = await env.call("css_edit", {
            tab,
            target      : { selector: "#card" },
            action      : "set_style",
            declarations: { "bad name": "red" },
        });

        expect(property.isError).toBe(true);
        expect(property.text).toContain("Property names");
    });
});

describe.skipIf(!present)("dom and css edits under safety options in a real browser", () => {
    it("refuses both tools in read-only mode", async () => {
        const locked = await startEnv({
            readOnly            : true,
            allowedDomains      : [],
            deniedDomains       : [], allowPrivateNetworks: true, confirmDangerous    : false,
        });

        try {
            const dom = await locked.call("dom_edit", {
                target: { selector: "#card" },
                action: "set_text",
                text  : "x",
            });
            const css = await locked.call("css_edit", {
                target      : { selector: "#card" },
                action      : "set_style",
                declarations: { color: "red" },
            });

            expect(dom.isError).toBe(true);
            expect(dom.text).toContain("read-only mode");
            expect(css.isError).toBe(true);
            expect(css.text).toContain("read-only mode");
        } finally {
            await locked.stop();
        }
    });

    it("refuses edits on a tab outside the allowlist", async () => {
        const guarded = await startEnv({
            readOnly            : false,
            allowedDomains      : ["127.0.0.1"],
            deniedDomains       : [], allowPrivateNetworks: true, confirmDangerous    : false,
        });

        try {
            guarded.fixture.pages.set("/edit-jump", html(
                `<script>setTimeout(() => { location.href = ${JSON.stringify(`${guarded.other.origin}/edit-cross`)}; }, 2000);</script>`,
            ));
            guarded.other.pages.set("/edit-cross", html(`<p id="cross">cross text</p>`));
            const opened = await guarded.ok("new_tab", { url: `${guarded.fixture.origin}/edit-jump` });
            const tab = String((opened.tab as { tab: string }).tab);

            await eventually(async () => {
                const info = (await guarded.ok("page_info", { tab })) as { url?: string };

                return JSON.stringify(info).includes("localhost") ? true : undefined;
            });

            const dom = await guarded.call("dom_edit", {
                tab,
                target: { selector: "#cross" },
                action: "set_text",
                text  : "x",
            });
            const css = await guarded.call("css_edit", {
                tab,
                target      : { selector: "#cross" },
                action      : "set_style",
                declarations: { color: "red" },
            });

            expect(dom.isError).toBe(true);
            expect(dom.text).toContain("outside safety.allowedDomains");
            expect(css.isError).toBe(true);
            expect(css.text).toContain("outside safety.allowedDomains");
        } finally {
            await guarded.stop();
        }
    });

    it("refuses an edit inside a frame from another origin", async () => {
        const guarded = await startEnv({
            readOnly            : false,
            allowedDomains      : ["127.0.0.1"],
            deniedDomains       : [], allowPrivateNetworks: true, confirmDangerous    : false,
        });

        try {
            guarded.fixture.pages.set("/edit", html(EDIT_PAGE));
            guarded.fixture.pages.set("/edit-inner", html(INNER));
            guarded.other.pages.set("/edit-cross", html(`<p id="cross">cross text</p>`));
            guarded.fixture.pages.set(
                "/edit-xframe",
                html(`<iframe name="cross" src="${guarded.other.origin}/edit-cross"></iframe>`),
            );
            const opened = await guarded.ok("new_tab", { url: `${guarded.fixture.origin}/edit-xframe` });
            const tab = String((opened.tab as { tab: string }).tab);
            const snap = (await guarded.ok("dom_snapshot", { tab })) as { frames: Row[] };
            const frame = String(
                snap.frames.find((entry) => String(entry.url).endsWith("/edit-cross"))?.frameId,
            );

            const dom = await guarded.call("dom_edit", {
                tab,
                target: { selector: "#cross", frame },
                action: "set_text",
                text  : "x",
            });
            const css = await guarded.call("css_edit", {
                tab,
                target      : { selector: "#cross", frame },
                action      : "set_style",
                declarations: { color: "red" },
            });

            expect(dom.isError).toBe(true);
            expect(dom.text).toContain("outside safety.allowedDomains");
            expect(css.isError).toBe(true);
            expect(css.text).toContain("outside safety.allowedDomains");
        } finally {
            await guarded.stop();
        }
    });
});
