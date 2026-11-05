import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

const PAGE = `<button id="late" disabled>Late</button>
<button id="shy" style="display:none">Shy</button>
<button id="under">Under</button>
<div id="veil" style="position:fixed;inset:0;background:rgba(0,0,0,.2)"></div>
<input id="field" disabled>
<select id="pick" disabled><option>a</option><option>b</option></select>
<button id="never" disabled>Never</button>
<script>
window.__clicks = [];
for (const id of ["late", "shy", "under", "never"]) {
  document.getElementById(id).addEventListener("click", () => window.__clicks.push(id));
}
setTimeout(() => { document.getElementById("late").disabled = false; }, 600);
setTimeout(() => { document.getElementById("shy").style.display = "inline-block"; }, 600);
setTimeout(() => { document.getElementById("veil").remove(); }, 600);
setTimeout(() => { document.getElementById("field").disabled = false; }, 600);
setTimeout(() => { document.getElementById("pick").disabled = false; }, 600);
</script>`;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/wait", html(PAGE));
});

afterAll(async () => {
    await env?.stop();
});

async function clicks(tab: string): Promise<string[]> {
    const result = (await env.ok("js_evaluate", { tab, expression: "window.__clicks" })) as {
        value?: string[];
    };

    return result.value ?? [];
}

describe.skipIf(!present)("waiting for an element in a real browser", () => {
    it("waits for a disabled button to be enabled before a DOM click", async () => {
        const tab = await env.open("/wait");
        const started = Date.now();

        await env.ok("click", { tab, target: { selector: "#late" } });

        expect(Date.now() - started).toBeGreaterThanOrEqual(400);
        expect(await clicks(tab)).toEqual(["late"]);
    });

    it("refuses at once with timeoutMs 0 and explains after a wait that was too short", async () => {
        const tab = await env.open("/wait");
        const started = Date.now();
        const quick = await env.call("click", { tab, target: { selector: "#never" }, timeoutMs: 0 });

        expect(quick.isError).toBe(true);
        expect(quick.text).toContain("disabled");
        expect(quick.text).not.toContain("did not change within");
        expect(Date.now() - started).toBeLessThan(1500);

        const waited = await env.call("click", { tab, target: { selector: "#never" }, timeoutMs: 300 });

        expect(waited.isError).toBe(true);
        expect(waited.text).toContain("did not change within 300 ms");
        expect(await clicks(tab)).toEqual([]);
    });

    it("waits for a hidden element to show and for a covering element to go away", async () => {
        const tab = await env.open("/wait");

        await env.ok("input_click", { tab, target: { selector: "#shy" } });
        await env.ok("input_click", { tab, target: { selector: "#under" } });

        expect(await clicks(tab)).toEqual(["shy", "under"]);
    });

    it("waits for a field and for a select to become usable", async () => {
        const tab = await env.open("/wait");

        await env.ok("input_type", { tab, target: { selector: "#field" }, text: "hello" });
        await env.ok("input_select", { tab, target: { selector: "#pick" }, indexes: [1] });

        const value = (await env.ok("js_evaluate", {
            tab,
            expression: "[document.getElementById('field').value, document.getElementById('pick').selectedIndex]",
        })) as { value?: unknown };

        expect(value.value).toEqual(["hello", 1]);
    });

    it("applies the wait to every field of fill_form", async () => {
        const tab = await env.open("/wait");
        const filled = await env.ok("fill_form", {
            tab,
            fields: [{ target: { selector: "#field" }, value: "x" }],
        });

        expect(filled).toMatchObject({ ok: true, filled: 1 });
    });
});
