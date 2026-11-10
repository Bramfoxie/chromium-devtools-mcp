import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, eventually, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

type Row = Record<string, unknown>;

function content(prefix: string): string {
    return `<main aria-label="${prefix} main"><form aria-label="${prefix} form">
<label>${prefix} field<input></label><button>${prefix} button</button></form>
<nav aria-label="${prefix} nav"><a href="#">${prefix} link</a></nav>
<p>${prefix} prose</p><div id="host"></div></main>
<script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML =
'<section aria-label="${prefix} shadow"><button>${prefix} shadow button</button><p>${prefix} shadow prose</p></section>';</script>`;
}

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/modes", html(`${content("main")}<iframe name="same" src="/same"></iframe><iframe name="cross" src="${env.other.origin}/cross"></iframe>`));
    env.fixture.pages.set("/same", html(content("same")));
    env.other.pages.set("/cross", html(`${content("cross")}<iframe name="nested" src="${env.fixture.origin}/nested"></iframe>`));
    env.fixture.pages.set("/nested", html(content("nested")));
});

afterAll(async () => {
    await env?.stop();
});

describe.skipIf(!present)("filtered snapshots in Chrome", () => {
    it.each(["interactive", "forms", "landmarks", "text"] as const)("renders %s across frames and shadow roots", async (mode) => {
        const tab = await env.open("/modes");

        await eventually(async () => {
            const result = await env.ok("dom_snapshot", { tab });

            return (result.frames as Row[]).length === 4 ? true : undefined;
        });
        const result = await env.ok("dom_snapshot", { tab, mode });
        const snapshot = String(result.snapshot);
        const frames = result.frames as Row[];

        expect(frames).toHaveLength(4);
        expect(frames.filter((frame) => frame.isolated === true).length).toBeGreaterThan(0);

        for (const prefix of ["main", "same", "cross", "nested"]) {
            expect(snapshot).toContain(`${prefix} main`);
            const lines = snapshot.split("\n");
            const ancestor = lines.findIndex((line) => line.includes(`main "${prefix} main"`));
            const child = lines.findIndex((line, index) => index > ancestor && line.includes(
                mode === "landmarks" ? `navigation "${prefix} nav"` :
                    mode === "text" ? `text "${prefix} prose"` : `button "${prefix} button"`,
            ));

            expect(ancestor).toBeGreaterThanOrEqual(0);
            expect(child).toBeGreaterThan(ancestor);
            expect(lines[child]?.search(/\S/)).toBeGreaterThan(lines[ancestor]?.search(/\S/) ?? 0);

            if (mode === "interactive" || mode === "forms") {
                expect(snapshot).toContain(`${prefix} button`);
                expect(snapshot).toContain(`${prefix} shadow button`);
                expect(snapshot).toContain(`${prefix} form`);
                expect(snapshot).not.toContain(`${prefix} prose`);
            } else if (mode === "landmarks") {
                expect(snapshot).toContain(`${prefix} nav`);
                expect(snapshot).toContain(`${prefix} shadow`);
                expect(snapshot).not.toContain(`${prefix} button`);
            } else {
                expect(snapshot).toContain(`${prefix} prose`);
                expect(snapshot).toContain(`${prefix} shadow prose`);
            }
        }

        expect(result.truncated).toBe(false);
        expect(result.nodeCount).toBeGreaterThan(0);
    });

    it("keeps ids usable within a generation and invalidates them on the next snapshot", async () => {
        const tab = await env.open("/modes");
        const result = await env.ok("dom_snapshot", { tab, mode: "interactive" });
        const uid = /\[([^\]]+)\] button "main shadow button"/.exec(String(result.snapshot))?.[1];

        expect(uid).toBeDefined();
        const query = await env.ok("dom_query", { tab, selector: "#host >>> button" });

        expect((query.matches as Row[])[0]?.uid).toBe(uid);
        await env.ok("dom_snapshot", { tab, mode: "forms" });
        const stale = await env.call("click", { tab, target: { uid } });

        expect(stale.isError).toBe(true);
        expect(stale.text).toContain("stale");
    });

    it.each(["interactive", "forms", "landmarks", "text"] as const)("reports character truncation in %s mode", async (mode) => {
        const tab = await env.open("/modes");
        const result = await env.ok("dom_snapshot", { tab, mode, maxChars: 30 });

        expect(result.truncated).toBe(true);
        expect(String(result.snapshot)).toContain("truncated");
    });
});
