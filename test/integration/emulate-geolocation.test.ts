import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;
let guarded: Env;

const POSITION = `new Promise((resolve) => {
  setTimeout(() => resolve({ ok: false, message: "no answer" }), 1500);
  navigator.geolocation.getCurrentPosition(
    (p) => resolve({ ok: true, lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
    (e) => resolve({ ok: false, message: e.message }), { timeout: 1000, maximumAge: 0 });
})`;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    guarded = await startEnv({
        readOnly        : false,
        allowedDomains  : ["127.0.0.1"],
        confirmDangerous: false,
    });
    env.fixture.pages.set("/page", html("<p>page</p>"));
    guarded.fixture.pages.set("/page", html("<p>page</p>"));
});

afterAll(async () => {
    await env?.stop();
    await guarded?.stop();
});

async function position(target: Env, tab: string): Promise<Record<string, unknown>> {
    const result = (await target.ok("js_evaluate", {
        tab,
        expression  : POSITION,
        awaitPromise: true,
    })) as { value?: Record<string, unknown> };

    return result.value ?? {};
}

describe.skipIf(!present)("emulate_geolocation in a real browser", () => {
    it("allows the origin of the tab and reports the position the page reads", async () => {
        const tab = await env.open("/page");
        const result = await env.ok("emulate_geolocation", {
            tab,
            latitude : 52.52,
            longitude: 13.405,
            accuracy : 25,
        });

        expect(result.reported).toMatchObject({
            ok       : true,
            latitude : 52.52,
            longitude: 13.405,
            accuracy : 25,
        });
        expect(result.emulation).toMatchObject({
            geolocation: {
                latitude : 52.52,
                longitude: 13.405,
                accuracy : 25,
                origin   : env.fixture.origin,
            },
        });
        expect(await position(env, tab)).toMatchObject({
            ok : true,
            lat: 52.52,
            lon: 13.405,
            acc: 25,
        });
    });

    it("leaves the other permissions of the origin alone", async () => {
        const tab = await env.open("/page");

        await env.ok("emulate_geolocation", { tab, latitude: 1, longitude: 2 });
        const result = (await env.ok("js_evaluate", { tab, expression: "Notification.permission" })) as {
            value?: string;
        };

        expect(result.value).toBe("default");
    });

    it("removes the override and the permission on reset", async () => {
        const tab = await env.open("/page");

        await env.ok("emulate_geolocation", { tab, latitude: 10, longitude: 20 });
        const result = await env.ok("emulate_geolocation", { tab, reset: true });

        expect(result.emulation).toEqual({});
        expect(await position(env, tab)).toMatchObject({ ok: false });
    });

    it("sets the location for an origin before the first navigation", async () => {
        const created = await env.ok("new_tab", {});
        const tab = String((created.tab as { tab: string }).tab);

        await env.ok("emulate_geolocation", {
            tab,
            latitude : 35.68,
            longitude: 139.69,
            origin   : env.fixture.origin,
        });
        await env.ok("page_navigate", { tab, url: `${env.fixture.origin}/page` });

        expect(await position(env, tab)).toMatchObject({ ok: true, lat: 35.68, lon: 139.69 });
    });

    it("asks for an origin when the tab shows no web page", async () => {
        const created = await env.ok("new_tab", {});
        const tab = String((created.tab as { tab: string }).tab);
        const result = await env.call("emulate_geolocation", { tab, latitude: 1, longitude: 2 });

        expect(result.isError).toBe(true);
        expect(result.text).toContain("Pass origin");
    });

    it("drops the permission when the tab is closed", async () => {
        const first = await env.open("/page");

        await env.ok("emulate_geolocation", { tab: first, latitude: 5, longitude: 6 });
        await env.ok("close_tab", { tab: first });
        const second = await env.open("/page");

        expect(await position(env, second)).toMatchObject({ ok: false });
    });
});

describe.skipIf(!present)("emulate_geolocation with allowedDomains in a real browser", () => {
    it("allows an origin in the list", async () => {
        const tab = await guarded.open("/page");
        const result = await guarded.ok("emulate_geolocation", { tab, latitude: 1, longitude: 2 });

        expect(result.reported).toMatchObject({ ok: true });
    });

    it("refuses an origin outside the list without touching the tab", async () => {
        const tab = await guarded.open("/page");
        const result = await guarded.call("emulate_geolocation", {
            tab,
            latitude : 1,
            longitude: 2,
            origin   : "https://evil.example",
        });

        expect(result.isError).toBe(true);
        expect(result.text).toContain("evil.example");
    });
});
