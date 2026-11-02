import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, eventually, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

type Row = Record<string, unknown>;

const INNER = `<h1 id="inner">cross</h1><button id="go" onclick="this.textContent='clicked'">go</button>
`;

async function crossTab(): Promise<string> {
    const tab = await env.open("/xframe");

    await eventually(async () => {
        const snap = await env.ok("dom_snapshot", { tab });

        return (snap.frames as Row[]).some((frame) => frame.isolated === true) ? true : undefined;
    });

    return tab;
}

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.other.pages.set("/inner", html(INNER));
    env.other.pages.set("/xdata", { body: "{\"from\":\"other\"}", status: 200, type: "application/json" });
    env.fixture.pages.set(
        "/xframe",
        html(`<iframe name="cross" id="cross" src="${env.other.origin}/inner"></iframe>`),
    );
}, 60_000);

afterAll(async () => {
    await env?.stop();
}, 60_000);

describe.skipIf(!present)("cross-site iframe in a real browser", { timeout: 30_000 }, () => {
    it("dom_snapshot lists the cross-site frame as isolated with its url and parent", async () => {
        const tab = await crossTab();
        const snap = await env.ok("dom_snapshot", { tab });
        const frames = snap.frames as Row[];
        const main = frames.find((frame) => frame.parent === undefined);
        const cross = frames.find((frame) => frame.isolated === true);

        expect(main).toBeDefined();
        expect(cross).toMatchObject({
            url   : `${env.other.origin}/inner`,
            parent: main?.frameId,
        });
    });

    it("dom_query reaches the cross-site frame by iframe selector and by frame id", async () => {
        const tab = await crossTab();
        const bySelector = await env.ok("dom_query", { tab, selector: "h1", frame: "iframe[name=cross]" });

        expect(bySelector.matches as Row[]).toHaveLength(1);
        const snap = await env.ok("dom_snapshot", { tab });
        const cross = (snap.frames as Row[]).find((frame) => frame.isolated === true);
        const byId = await env.ok("dom_query", { tab, selector: "h1", frame: String(cross?.frameId) });

        expect(byId.matches as Row[]).toHaveLength(1);
    });

    it("click acts on an element of the cross-site frame by selector and by uid", async () => {
        const tab = await crossTab();
        const frame = "iframe[name=cross]";
        const textOf = async () => {
            const read = await env.ok("dom_query", { tab, selector: "#go", frame, attributes: [] });

            return (read.matches as Row[])[0];
        };

        await env.ok("click", { tab, target: { selector: "#go", frame } });
        expect((await textOf())?.text).toBe("clicked");
        const uid = String((await textOf())?.uid);

        await env.ok("click", { tab, target: { uid } });
        const input = await env.call("input_click", { tab, target: { selector: "#go", frame } });

        expect(input.isError).toBe(true);
        expect(input.text).toContain("cross-site frame");
    });
});
