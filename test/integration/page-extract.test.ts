import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

const PAGE = `<!doctype html><html lang="de"><head><title>Extract page</title>
<meta name="description" content="A page to read">
<meta property="og:title" content="Shared title">
<link rel="canonical" href="/canonical?session=CANON-SECRET">
</head><body>
<h1>Main heading</h1><h2>Second <b>level</b></h2>
<a href="/plain" rel="noopener">Plain link</a>
<a href="/login?access_token=LINK-SECRET&page=2">Token link</a>
<a>No href anchor</a>
<form id="f" name="signin" method="post" action="/submit?key=FORM-SECRET">
  <label for="u">User</label><input id="u" name="user" required value="alice-typed">
  <input type="password" name="pass" value="PASSWORD-VALUE" placeholder="Password">
  <input type="hidden" name="csrf" value="HIDDEN-VALUE">
  <select name="kind"><option value="a" selected>A</option></select>
  <textarea name="note">NOTE-VALUE</textarea>
</form>
<iframe srcdoc="<a href='/in-frame'>inside</a><h1>Frame heading</h1>"></iframe>
</body></html>`;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/extract", html(PAGE));
});

afterAll(async () => {
    await env?.stop();
});

describe.skipIf(!present)("page_extract in a real browser", () => {
    it("lists links, headings, meta tags and form structure without values or secrets", async () => {
        const tab = await env.open("/extract");
        const page = await env.ok("page_extract", { tab });
        const text = JSON.stringify(page);

        expect(page).toMatchObject({
            title   : "Extract page",
            lang    : "de",
            links   : { total: 2, truncated: false },
            headings: {
                total: 2,
                items: [{ level: 1, text: "Main heading" }, { level: 2, text: "Second level" }],
            },
            meta : { total: 2 },
            forms: { total: 1, truncated: false },
        });

        for (const secret of [
            "PASSWORD-VALUE",
            "HIDDEN-VALUE",
            "NOTE-VALUE",
            "alice-typed",
            "LINK-SECRET",
            "FORM-SECRET",
            "CANON-SECRET",
        ]) {
            expect(text).not.toContain(secret);
        }

        const forms = page.forms as { items: Array<Record<string, unknown>> };

        expect(forms.items[0]).toMatchObject({ id: "f", name: "signin", method: "post", fieldTotal: 5 });
        expect(forms.items[0]?.fields).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: "user", label: "User", required: true }),
                expect.objectContaining({ type: "password", name: "pass", label: "Password" }),
                expect.objectContaining({ type: "hidden", name: "csrf" }),
            ]),
        );
        expect(text).not.toContain("Frame heading");
    });

    it("caps each list at the limit and says how many exist", async () => {
        const tab = await env.open("/extract");
        const page = await env.ok("page_extract", { tab, kinds: ["links"], limit: 1 });

        expect(page).toMatchObject({ links: { total: 2, truncated: true } });
        expect((page.links as { items: unknown[] }).items).toHaveLength(1);
        expect(page.headings).toBeUndefined();
    });
});
