import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, eventually, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;
const page = `<button id="target"><span id="child">child</span></button><script>
const target = document.querySelector('#target');
target.addEventListener('click', () => {}, {capture: true, passive: true, once: true});
target.addEventListener('keydown', () => {});
document.querySelector('#child').addEventListener('child-event', () => {});
</script>`;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/listeners", html(`${page}<iframe id="cross" src="${env.other.origin}/listeners"></iframe>`));
    env.other.pages.set("/listeners", html(page));
});

afterAll(async () => { await env?.stop(); });

describe.skipIf(!present)("event listeners in Chrome", () => {
    it("reads only the selected element in the main and cross-site frames", async () => {
        const tab = await env.open("/listeners");

        await eventually(async () => {
            const result = await env.ok("dom_snapshot", { tab });

            return (result.frames as Array<{ isolated: boolean }>).some((frame) => frame.isolated)
                ? true : undefined;
        });

        for (const target of [{ selector: "#target" }, { selector: "#target", frame: "#cross" }]) {
            const result = await env.ok("event_listeners", { tab, target });

            expect(result).toEqual({ listeners: [
                { type: "click", useCapture: true, passive: true, once: true },
                { type: "keydown", useCapture: false, passive: false, once: false },
            ], total: 2, truncated: false });
        }
    });
});
