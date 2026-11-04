import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

interface Inspected {
    computed     : Record<string, string>;
    matchedRules : Array<{ selector: string }>;
    forcedStates?: string[];
}

const PAGE = `<style>
  #b { background-color: rgb(0, 0, 255); transition: none; }
  #b:hover { background-color: rgb(255, 0, 0); }
  #b:active { background-color: rgb(0, 255, 0); }
  #f { outline: none; border: 1px solid rgb(10, 10, 10); }
  #f:focus { border-color: rgb(1, 2, 3); }
  #w:focus-within { background-color: rgb(9, 9, 9); }
</style>
<button id="b">Button</button>
<input id="f">
<div id="w"><input id="inner"></div>`;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/force", html(PAGE));
});

afterAll(async () => {
    await env?.stop();
});

const inspect = async (tab: string, selector: string, forceStates?: string[]) =>
    (await env.ok("css_inspect", {
        tab,
        target    : { selector },
        properties: ["background-color", "border-top-color"],
        includeBox: false,
        ...(forceStates === undefined ? {} : { forceStates }),
    })) as unknown as Inspected;

const live = async (tab: string, selector: string, property: string) =>
    ((await env.ok("js_evaluate", {
        tab,
        expression: `getComputedStyle(document.querySelector(${JSON.stringify(selector)}))["${property}"]`,
    })) as { value?: string }).value;

describe.skipIf(!present)("forcing pseudo classes in a real browser", () => {
    it("shows the hover rule while it forces hover and puts the page back afterwards", async () => {
        const tab = await env.open("/force");
        const plain = await inspect(tab, "#b");
        const hover = await inspect(tab, "#b", ["hover"]);

        expect(plain.computed["background-color"]).toBe("rgb(0, 0, 255)");
        expect(plain.matchedRules.map((rule) => rule.selector)).not.toContain("#b:hover");
        expect(hover.computed["background-color"]).toBe("rgb(255, 0, 0)");
        expect(hover.matchedRules.map((rule) => rule.selector)).toContain("#b:hover");
        expect(hover.forcedStates).toEqual(["hover"]);
        expect(await live(tab, "#b", "backgroundColor")).toBe("rgb(0, 0, 255)");
    });

    it("forces active, focus and focus-within, alone or together", async () => {
        const tab = await env.open("/force");

        expect((await inspect(tab, "#b", ["active"])).computed["background-color"]).toBe("rgb(0, 255, 0)");
        expect((await inspect(tab, "#f", ["focus"])).computed["border-top-color"]).toBe("rgb(1, 2, 3)");
        expect((await inspect(tab, "#w", ["focus-within"])).computed["background-color"]).toBe(
            "rgb(9, 9, 9)",
        );
        expect((await inspect(tab, "#b", ["hover", "active"])).computed["background-color"]).toMatch(
            /rgb\((255, 0, 0|0, 255, 0)\)/,
        );
        expect(await live(tab, "#f", "borderTopColor")).toBe("rgb(10, 10, 10)");
        expect(await live(tab, "#w", "backgroundColor")).toBe("rgba(0, 0, 0, 0)");
    });

    it("leaves the real focus and hover of the page alone", async () => {
        const tab = await env.open("/force");

        await inspect(tab, "#f", ["focus", "hover"]);

        const state = (await env.ok("js_evaluate", {
            tab,
            expression: "[document.activeElement === document.getElementById('f'), document.getElementById('f').matches(':hover')]",
        })) as { value?: unknown };

        expect(state.value).toEqual([false, false]);
    });
});
