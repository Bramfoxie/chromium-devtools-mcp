import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, eventually, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;
let guarded: Env;

const BUTTON = `<button id="b" style="position:absolute;left:100px;top:60px;width:80px;height:40px"
  onclick="fetch('/clicked-main')">b</button>`;

const FRAME_PAGE = (origin: string) =>
    `<iframe id="f" style="position:absolute;left:50px;top:50px;width:200px;height:120px;border:0" src="${origin}/inside"></iframe>`;

const INSIDE = `<button style="position:fixed;inset:0;width:100%;height:100%"
  onclick="fetch('/clicked-frame')">x</button>`;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    guarded = await startEnv({
        readOnly            : false,
        allowedDomains      : ["127.0.0.1"],
        deniedDomains       : [], allowPrivateNetworks: true, confirmDangerous    : false,
    });

    for (const target of [env, guarded]) {
        target.fixture.pages.set("/button", html(BUTTON));
        target.fixture.pages.set("/frame", html(FRAME_PAGE(target.other.origin)));
        target.other.pages.set("/inside", html(INSIDE));
    }
});

afterAll(async () => {
    await env?.stop();
    await guarded?.stop();
});

describe.skipIf(!present)("input_click at a point in a real browser", () => {
    it("clicks the element under the point and reports it", async () => {
        const tab = await env.open("/button");
        const result = await env.ok("input_click", { tab, point: { x: 140, y: 80 } });

        expect(result.target).toMatchObject({ tag: "button", id: "b" });
        await eventually(() => (env.fixture.hits.get("/clicked-main") ?? 0) >= 1 || undefined);
    });

    it("lets a point be read from a screenshot through its pixel ratio", async () => {
        const tab = await env.open("/button");
        const shot = await env.ok("screenshot", { tab, format: "png" });
        const size = (await env.ok("js_evaluate", {
            tab,
            expression: "({ w: innerWidth, h: innerHeight })",
        })) as { value?: { w: number; h: number } };

        const ratio = Number(shot.pixelRatio);

        expect(ratio).toBeGreaterThan(0);
        expect(size.value).toEqual({
            w: Math.round(Number(shot.width) / ratio),
            h: Math.round(Number(shot.height) / ratio),
        });
    });

    it("refuses a point outside the viewport", async () => {
        const tab = await env.open("/button");
        const result = await env.call("input_click", { tab, point: { x: 100000, y: 10 } });

        expect(result.isError).toBe(true);
        expect(result.text).toContain("outside the viewport");
    });

    it("clicks inside a cross-site frame through the page coordinates", async () => {
        const tab = await env.open("/frame");

        await eventually(async () => {
            const snap = await env.ok("dom_snapshot", { tab });

            const frames = snap.frames as Array<Record<string, unknown>>;

            return frames.some((frame) => frame.isolated === true) ? true : undefined;
        });
        let result: Record<string, unknown> = {};

        await eventually(async () => {
            result = await env.ok("input_click", { tab, point: { x: 150, y: 110 } });

            return (env.other.hits.get("/clicked-frame") ?? 0) >= 1 ? true : undefined;
        }, 20_000);

        expect(result.target).toMatchObject({ tag: "iframe" });
    });
});

describe.skipIf(!present)("input_click at a point with allowedDomains in a real browser", () => {
    it("clicks a point in the main frame", async () => {
        const tab = await guarded.open("/button");

        await guarded.ok("input_click", { tab, point: { x: 140, y: 80 } });
        await eventually(() => (guarded.fixture.hits.get("/clicked-main") ?? 0) >= 1 || undefined);
    });

    it("refuses a point inside a frame from another origin", async () => {
        const tab = await guarded.open("/frame");

        await eventually(async () => {
            const snap = await guarded.ok("dom_snapshot", { tab });

            return (snap.frames as Array<Record<string, unknown>>).length > 0 ? true : undefined;
        });
        const result = await guarded.call("input_click", { tab, point: { x: 150, y: 110 } });

        expect(result.isError).toBe(true);
        expect(result.text).toContain("localhost");
        expect(guarded.other.hits.get("/clicked-frame") ?? 0).toBe(0);
    });
});
