import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, eventually, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

type Row = Record<string, unknown>;

const POINTER = `<div style="height:30px"></div>
<button id="b" style="margin-left:20px;width:80px;height:40px" onclick="this.textContent='clicked'">b</button>
<button id="h" style="margin-left:20px;width:80px;height:40px" onmouseover="this.textContent='hovered'">h</button>`;

const FORMS = `<input id="t"><div id="out">idle</div>
<select id="s"><option value="a">A</option><option value="b">B</option></select>
<input id="f" type="file">
<div style="height:3000px"></div><button id="far">far</button>
<script>document.getElementById("t").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("out").textContent = "enter";
});</script>`;

const nest = (deep: string) =>
    `<div style="height:20px"></div><iframe name="inner" style="margin-left:15px;border:2px solid blue;width:250px;height:150px" src="${deep}"></iframe>`;

const DEEP = `<button id="d" style="margin:10px;width:60px;height:30px" onclick="this.textContent='deepclicked'">d</button>`;

const INNER = `<h1 id="inner">cross</h1><button id="go" onclick="this.textContent='clicked'">go</button>
<script>addEventListener("message",()=>{fetch("/xdata");console.log("oopif-message")})</script>`;

async function trigger(tab: string): Promise<void> {
    await env.ok("js_evaluate", { tab, expression: "frames[0].postMessage('go', '*'); 1" });
}

async function crossTab(route = "/xframe", count = 1): Promise<string> {
    const tab = await env.open(route);

    await eventually(async () => {
        const snap = await env.ok("dom_snapshot", { tab });

        return (snap.frames as Row[]).filter((frame) => frame.isolated === true).length >= count
            ? true
            : undefined;
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
    env.other.pages.set("/pointer", html(POINTER));
    env.other.pages.set("/forms", html(FORMS));
    env.fixture.pages.set(
        "/xforms",
        html(`<div style="height:900px"></div><iframe name="cross" style="width:500px;height:300px" src="${env.other.origin}/forms"></iframe><div style="height:900px"></div>`),
    );
    env.other.pages.set("/nest", html(nest(`${env.fixture.origin}/deep`)));
    env.other.pages.set(
        "/leaf",
        html(`<button id="q" onclick="this.textContent='leafclicked'">leaf</button>`),
    );
    env.other.pages.set(
        "/wrap",
        html(`<button id="w">wrap</button><iframe name="same" src="${env.other.origin}/leaf"></iframe>`),
    );
    env.fixture.pages.set(
        "/xwrap",
        html(`<iframe name="cross" src="${env.other.origin}/wrap"></iframe>`),
    );
    env.fixture.pages.set("/deep", html(DEEP));
    env.fixture.pages.set(
        "/xpointer",
        html(`<div style="height:1400px"></div><iframe name="cross" style="margin-left:40px;border:4px solid red;padding:6px;width:320px;height:240px" src="${env.other.origin}/pointer"></iframe><div style="height:600px"></div>`),
    );
    env.fixture.pages.set(
        "/xnested",
        html(`<iframe name="outer" style="margin:30px 0 0 25px;border:3px solid red;padding:5px;width:400px;height:300px" src="${env.other.origin}/nest"></iframe>`),
    );
}, 60_000);

afterAll(async () => {
    await env?.stop();
}, 60_000);

async function textOf(tab: string, selector: string, frame: string): Promise<unknown> {
    const read = await env.ok("dom_query", { tab, selector, frame, attributes: [] });

    return (read.matches as Row[])[0]?.text;
}

async function frameIdOf(tab: string, urlEnd: string): Promise<string> {
    const snap = await env.ok("dom_snapshot", { tab });
    const found = (snap.frames as Row[]).find((frame) => String(frame.url).endsWith(urlEnd));

    return String(found?.frameId);
}

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
    });

    it("network_requests records a request made by the cross-site frame", async () => {
        const tab = await crossTab();

        await env.ok("network_requests", { tab });
        await trigger(tab);
        const read = await eventually(async () => {
            const result = await env.ok("network_requests", { tab, urlContains: "/xdata" });

            const rows = result.requests as Row[];

            return rows.some((row) => row.status === 200) ? result : undefined;
        });

        expect((read.requests as Row[])[0]).toMatchObject({ status: 200 });
    });

    it("console_logs records a message logged by the cross-site frame", async () => {
        const tab = await crossTab();

        await env.ok("console_logs", { tab });
        await trigger(tab);
        const read = await eventually(async () => {
            const result = await env.ok("console_logs", { tab, textContains: "oopif-message" });

            return (result.entries as Row[]).length > 0 ? result : undefined;
        });

        expect(read.entries as Row[]).toHaveLength(1);
    });

    it("network_mock fulfills a request made by the cross-site frame", async () => {
        const tab = await crossTab();

        await env.ok("network_mock", {
            tab,
            action: "add",
            rule  : { urlPattern: "*/xdata", response: { status: 200, body: "mocked", contentType: "text/plain" } },
        });
        const before = env.other.hits.get("/xdata") ?? 0;

        await env.ok("network_requests", { tab, clear: true });
        await trigger(tab);
        const listed = await eventually(async () => {
            const result = await env.ok("network_mock", { tab, action: "list" });

            return (result.rules as Row[])[0]?.applications === 1 ? result : undefined;
        });

        expect((listed.rules as Row[])[0]).toMatchObject({ applications: 1 });
        expect(env.other.hits.get("/xdata") ?? 0).toBe(before);
        await env.ok("network_mock", { tab, action: "clear" });
    });

    it("input_click clicks an element in an iframe that starts below the viewport", async () => {
        const tab = await crossTab("/xpointer");
        const frame = "iframe[name=cross]";
        const outcome = await env.ok("input_click", { tab, target: { selector: "#b", frame } });

        expect(outcome.ok).toBe(true);
        expect(await textOf(tab, "#b", frame)).toBe("clicked");
        const scrolled = await env.ok("js_evaluate", { tab, expression: "window.scrollY" });

        expect(Number(scrolled.value)).toBeGreaterThan(0);
    });

    it("input_click reaches an element two cross-site frames deep", async () => {
        const tab = await crossTab("/xnested", 2);
        const frame = await frameIdOf(tab, "/deep");
        const outcome = await env.ok("input_click", { tab, target: { selector: "#d", frame } });

        expect(outcome.ok).toBe(true);
        expect(await textOf(tab, "#d", frame)).toBe("deepclicked");
    });

    it("input_hover hovers an element of the cross-site frame", async () => {
        const tab = await crossTab("/xpointer");
        const frame = "iframe[name=cross]";
        const outcome = await env.ok("input_hover", { tab, target: { selector: "#h", frame } });

        expect(outcome.hovered).toBe(true);
        expect(await textOf(tab, "#h", frame)).toBe("hovered");
    });

    it("input_click refuses when an element of the parent page covers the iframe", async () => {
        const tab = await crossTab("/xpointer");
        const frame = "iframe[name=cross]";

        await env.ok("js_evaluate", {
            tab,
            expression: "const o = document.createElement('div'); o.id = 'veil'; o.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%'; document.body.append(o); 1",
        });
        const refused = await env.call("input_click", { tab, target: { selector: "#b", frame } });

        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("veil");
        expect(await textOf(tab, "#b", frame)).toBe("b");
    });

    it("input_type types into a field of the cross-site frame and reads the value back", async () => {
        const tab = await crossTab("/xforms");
        const frame = "iframe[name=cross]";
        const typed = await env.ok("input_type", { tab, target: { selector: "#t", frame }, text: "hello" });

        expect(typed).toMatchObject({ ok: true, contains: true, valueLength: 5 });
        const slow = await env.ok("input_type", {
            tab,
            target : { selector: "#t", frame },
            text   : "ab",
            delayMs: 5,
        });

        expect(slow).toMatchObject({ ok: true, contains: true, valueLength: 7 });
    });

    it("input_key presses a key in the focused field of the cross-site frame", async () => {
        const tab = await crossTab("/xforms");
        const frame = "iframe[name=cross]";

        await env.ok("input_key", { tab, target: { selector: "#t", frame }, key: "Enter" });

        expect(await textOf(tab, "#out", frame)).toBe("enter");
    });

    it("input_select picks an option of a select in the cross-site frame", async () => {
        const tab = await crossTab("/xforms");
        const picked = await env.ok("input_select", {
            tab,
            target: { selector: "#s", frame: "iframe[name=cross]" },
            labels: ["B"],
        });

        expect(picked.selected).toEqual([{ value: "b", label: "B" }]);
    });

    it("input_upload attaches a file to a file input of the cross-site frame", async () => {
        const tab = await crossTab("/xforms");
        const dir = await realpath(await mkdtemp(join(tmpdir(), "cdm-xsite-up-")));

        try {
            const file = join(dir, "note.txt");

            await writeFile(file, "payload");
            const attached = await env.ok("input_upload", {
                tab,
                target: { selector: "#f", frame: "iframe[name=cross]" },
                files : [file],
            });

            expect(attached.files).toEqual([{ name: "note.txt", size: 7 }]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("input_scroll brings an element of the cross-site frame into view", async () => {
        const tab = await crossTab("/xforms");
        const scrolled = await env.ok("input_scroll", {
            tab,
            target: { selector: "#far", frame: "iframe[name=cross]" },
        });

        expect(scrolled).toMatchObject({ ok: true, method: "intoView" });
        expect(Number(scrolled.y)).toBeGreaterThan(0);
    });

    it("input_click reaches an element of a frame nested in the cross-site frame", async () => {
        const tab = await crossTab("/xwrap", 2);
        const frame = await frameIdOf(tab, "/leaf");
        const outcome = await env.ok("input_click", { tab, target: { selector: "#q", frame } });

        expect(outcome.ok).toBe(true);
        expect(await textOf(tab, "#q", frame)).toBe("leafclicked");
    });
});
