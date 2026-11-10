import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set("/permissions", html("<p>Permissions</p>"));
});

afterAll(async () => {
    await env?.stop();
});

describe.skipIf(!present)("permissions in a real browser", () => {
    it.each(["geolocation", "notifications", "camera", "microphone", "clipboard-read", "clipboard-write"])(
        "accepts grant, deny and reset for %s", async (name) => {
            const tab = await env.open("/permissions");
            const origin = env.fixture.origin;
            const read = async () => (await env.ok("js_evaluate", {
                tab, expression: `navigator.permissions.query({name:${JSON.stringify(name)}}).then(p => p.state)`,
            })).value;

            await env.ok("permissions", { name, origin, setting: "denied" });
            expect(await read()).toBe("denied");
            await env.ok("permissions", { name, origin, setting: "granted" });
            expect(await read()).toBe("granted");
            await env.ok("permissions", { name, origin, setting: "reset" });
        },
    );

    it("grants, denies and resets a permission for the session origin", async () => {
        const tab = await env.open("/permissions");
        const origin = env.fixture.origin;
        const read = async () => (await env.ok("js_evaluate", {
            tab, expression: "navigator.permissions.query({name:'camera'}).then(p => p.state)",
        })).value;

        await env.ok("permissions", { name: "camera", origin, setting: "denied" });
        expect(await read()).toBe("denied");
        await env.ok("permissions", { name: "camera", origin, setting: "granted" });
        expect(await read()).toBe("granted");
        await env.ok("permissions", { name: "camera", origin, setting: "reset" });
        expect(await read()).toBe("prompt");
    });
});
