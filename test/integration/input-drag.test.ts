import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, eventually, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;
let guarded: Env;

const NATIVE = `<div id="src" draggable="true" style="position:absolute;left:20px;top:20px;width:80px;height:40px;background:#9cf">drag me</div>
<div id="dst" style="position:absolute;left:300px;top:120px;width:120px;height:80px;background:#fc9">drop here</div>
<div id="log" style="position:absolute;left:20px;top:300px"></div>
<script>
const log = (text) => { document.getElementById("log").textContent += text + ";"; };
const dst = document.getElementById("dst");
document.getElementById("src").addEventListener("dragstart", (event) => {
  event.dataTransfer.setData("text/plain", "payload");
  log("dragstart");
});
dst.addEventListener("dragover", (event) => event.preventDefault());
dst.addEventListener("drop", (event) => {
  event.preventDefault();
  log("drop:" + event.dataTransfer.getData("text/plain"));
});
</script>`;

const POINTER = `<div id="knob" style="position:absolute;left:20px;top:20px;width:30px;height:30px;background:#9c9">k</div>
<div id="log" style="position:absolute;left:20px;top:300px"></div>
<script>
const log = (text) => { document.getElementById("log").textContent += text + ";"; };
let down = false, moves = 0;
const knob = document.getElementById("knob");
knob.addEventListener("mousedown", () => { down = true; moves = 0; log("down"); });
addEventListener("mousemove", (event) => { if (down) { moves += 1; knob.dataset.x = event.clientX; knob.dataset.y = event.clientY; } });
addEventListener("mouseup", (event) => {
  if (!down) return;
  down = false;
  log("up:" + event.clientX + "," + event.clientY + ":" + (moves > 1 ? "moved" : "jumped"));
});
</script>`;

const FRAME_PAGE = (origin: string) =>
    `<div id="here" style="position:absolute;left:20px;top:20px;width:60px;height:30px;background:#9cf">here</div>
<iframe id="f" style="position:absolute;left:200px;top:50px;width:200px;height:120px;border:0" src="${origin}/inside"></iframe>`;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    guarded = await startEnv({
        readOnly            : false,
        allowedDomains      : ["127.0.0.1"],
        deniedDomains       : [], allowPrivateNetworks: true, confirmDangerous    : false,
        uploadDirs          : [],
    });

    for (const target of [env, guarded]) {
        target.fixture.pages.set("/native", html(NATIVE));
        target.fixture.pages.set("/pointer", html(POINTER));
        target.fixture.pages.set("/frame", html(FRAME_PAGE(target.other.origin)));
        target.other.pages.set("/inside", html("<p>inside</p>"));
    }
});

afterAll(async () => {
    await env?.stop();
    await guarded?.stop();
});

async function logOf(target: Env, tab: string): Promise<string> {
    const result = (await target.ok("js_evaluate", {
        tab,
        expression: "document.getElementById('log').textContent",
    })) as { value?: string };

    return result.value ?? "";
}

describe.skipIf(!present)("input_drag in a real browser", () => {
    it("drops an element on another with native drag events", async () => {
        const tab = await env.open("/native");
        const result = await env.ok("input_drag", {
            tab,
            from: { selector: "#src" },
            to  : { selector: "#dst" },
        });

        expect(result.kind).toBe("html5");
        await eventually(async () => ((await logOf(env, tab)).includes("drop:payload") ? true : undefined));
        expect(await logOf(env, tab)).toBe("dragstart;drop:payload;");
    });

    it("drags between viewport points", async () => {
        const tab = await env.open("/native");
        const result = await env.ok("input_drag", {
            tab,
            from: { x: 60, y: 40 },
            to  : { x: 360, y: 160 },
        });

        expect(result).toMatchObject({ kind: "html5", from: { x: 60, y: 40 }, to: { x: 360, y: 160 } });
        expect(await logOf(env, tab)).toBe("dragstart;drop:payload;");
    });

    it("performs a plain mouse drag when nothing is draggable", async () => {
        const tab = await env.open("/pointer");
        const result = await env.ok("input_drag", {
            tab,
            from : { selector: "#knob" },
            to   : { x: 240, y: 180 },
            steps: 5,
        });

        expect(result.kind).toBe("pointer");
        expect(await logOf(env, tab)).toBe("down;up:240,180:moved;");
    });

    it("refuses a point outside the viewport and leaves no button pressed", async () => {
        const tab = await env.open("/pointer");
        const refused = await env.call("input_drag", {
            tab,
            from: { selector: "#knob" },
            to  : { x: 100000, y: 10 },
        });

        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("outside the viewport");
        expect(await logOf(env, tab)).toBe("");
    });

    it("refuses an element inside a cross-site frame and names the way out", async () => {
        const tab = await env.open("/frame");

        await eventually(async () => {
            const snap = await env.ok("dom_snapshot", { tab });
            const frames = snap.frames as Array<Record<string, unknown>>;

            return frames.some((frame) => frame.isolated === true) ? true : undefined;
        });
        const refused = await env.call("input_drag", {
            tab,
            from: { selector: "#here" },
            to  : { selector: "p", frame: "#f" },
        });

        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("Pass a point instead");
    });
});

describe.skipIf(!present)("input_drag with allowedDomains in a real browser", () => {
    it("drags in the main frame", async () => {
        const tab = await guarded.open("/native");
        const result = await guarded.ok("input_drag", {
            tab,
            from: { selector: "#src" },
            to  : { selector: "#dst" },
        });

        expect(result.kind).toBe("html5");
    });

    it("refuses a drop point inside a frame from another origin before pressing anything", async () => {
        const tab = await guarded.open("/frame");

        await eventually(async () => {
            const snap = await guarded.ok("dom_snapshot", { tab });

            return (snap.frames as unknown[]).length > 0 ? true : undefined;
        });
        const refused = await guarded.call("input_drag", {
            tab,
            from: { selector: "#here" },
            to  : { x: 300, y: 100 },
        });

        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("localhost");
    });
});
