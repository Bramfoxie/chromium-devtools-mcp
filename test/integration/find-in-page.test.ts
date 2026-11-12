import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

const PAGE = `<!doctype html><title>Find</title>
<style>.gap { height: 3000px }</style>
<p id="top">Alpha needle at the top</p>
<p id="unicode">&#304; MIXED unicode</p>
<p style="display:none">hidden needle</p>
<p style="visibility:hidden">invisible needle</p>
<script>document.write("<scr" + "ipt>var inScript = 'script needle'</scr" + "ipt>")</script>
<textarea>textarea needle</textarea>
<div class="gap"></div>
<p id="bottom">Omega NEEDLE at the bottom</p>
<div id="host"></div>
<script>
  const root = document.getElementById("host").attachShadow({ mode: "open" });
  root.innerHTML = "<span>shadow needle</span>";
</script>`;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/find", html(PAGE));
    env.fixture.pages.set("/find-unicode", html("<!doctype html><p>&#128512;&#304;&#304;&#128512;</p>"));
});

afterAll(async () => {
    await env?.stop();
});

describe.skipIf(!present)("find_in_page in a real browser", () => {
    it("finds case insensitive matches after a character with a longer lowercase form", async () => {
        const tab = await env.open("/find");
        const result = await env.ok("find_in_page", { tab, text: "mixed" });
        const folded = await env.ok("find_in_page", { tab, text: "i\u0307" });
        const exact = await env.ok("find_in_page", { tab, text: "\u0130", caseSensitive: true });

        expect(result).toMatchObject({ total: 1, matches: [{ context: expect.stringContaining("MIXED") }] });
        expect(folded).toMatchObject({ total: 1 });
        expect((folded.matches as Array<{ rect: unknown }>)[0]?.rect)
            .toEqual((exact.matches as Array<{ rect: unknown }>)[0]?.rect);
    });

    it("maps adjacent expanded characters and supplementary characters to their original ranges", async () => {
        const tab = await env.open("/find-unicode");
        const partial = await env.ok("find_in_page", { tab, text: "\u0307" });
        const exact = await env.ok("find_in_page", { tab, text: "\u0130", caseSensitive: true });
        const combined = await env.ok("find_in_page", { tab, text: "\ud83d\ude00i\u0307" });

        expect(partial).toMatchObject({ total: 2 });
        expect(exact).toMatchObject({ total: 2 });
        expect((partial.matches as Array<{ rect: unknown }>).map((match) => match.rect))
            .toEqual((exact.matches as Array<{ rect: unknown }>).map((match) => match.rect));
        expect(combined).toMatchObject({ total: 1 });
    });

    it("lists visible matches only, in document order, including a shadow root", async () => {
        const tab = await env.open("/find");
        const page = await env.ok("find_in_page", { tab, text: "needle" });
        const contexts = (page.matches as Array<{ context: string }>).map((match) => match.context);

        expect(page).toMatchObject({
            total     : 3,
            truncated : false,
            incomplete: false,
            scrolled  : false,
        });
        expect(contexts[0]).toContain("Alpha needle");
        expect(contexts[1]).toContain("Omega NEEDLE");
        expect(contexts[2]).toContain("shadow needle");
        expect(JSON.stringify(page)).not.toContain("hidden needle");
        expect(JSON.stringify(page)).not.toContain("textarea needle");
        expect(JSON.stringify(page)).not.toContain("script needle");
    });

    it("respects case sensitivity and reports no match as zero", async () => {
        const tab = await env.open("/find");
        const exact = await env.ok("find_in_page", { tab, text: "NEEDLE", caseSensitive: true });
        const none = await env.ok("find_in_page", { tab, text: "absent phrase" });

        expect(exact).toMatchObject({ total: 1 });
        expect(none).toMatchObject({ total: 0, matches: [] });
    });

    it("changes nothing without scroll and scrolls the chosen match into view with it", async () => {
        const tab = await env.open("/find");
        const before = await env.ok("find_in_page", { tab, text: "Omega" });

        expect(before.matches).toMatchObject([{ inViewport: false }]);
        expect((await env.ok("page_info", { tab })).scroll).toMatchObject({ y: 0 });

        const after = await env.ok("find_in_page", { tab, text: "Omega", scroll: true });

        expect(after).toMatchObject({ scrolled: true });
        expect(after.matches).toMatchObject([{ inViewport: true }]);
        expect(((await env.ok("page_info", { tab })).scroll as { y: number }).y).toBeGreaterThan(1000);
    });

    it("caps the list at maxMatches and says how many exist", async () => {
        const tab = await env.open("/find");
        const page = await env.ok("find_in_page", { tab, text: "needle", maxMatches: 1 });

        expect(page).toMatchObject({ total: 3, truncated: true });
        expect(page.matches).toHaveLength(1);
    });
});
