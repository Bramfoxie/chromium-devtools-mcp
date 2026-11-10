import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, eventually, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv({ readOnly: false, allowedDomains: ["127.0.0.1"], deniedDomains: [], allowPrivateNetworks: true, confirmDangerous: false, uploadDirs: [] });
    env.fixture.pages.set("/a", html("<p id=a>a</p>"));
    env.fixture.pages.set(
        "/nested",
        html(`<iframe name="wrap" src="${env.other.origin}/wrap"></iframe>
<iframe name="same" src="/same-inner"></iframe>`),
    );
    env.fixture.pages.set(
        "/same-inner",
        html("<button id=ib onclick=\"fetch('/clicked-same')\">in</button>"),
    );
    env.other.pages.set(
        "/wrap",
        html(`<iframe srcdoc="<button id=sb onclick=&quot;fetch('/clicked-nested')&quot;>sb</button>"></iframe>`),
    );
    env.fixture.pages.set("/b", html("<p id=b>b</p>"));
    env.other.pages.set("/forbidden", html("<p>forbidden</p>"));
    env.fixture.pages.set("/redirect", {
        body   : "",
        status : 302,
        type   : "text/plain",
        headers: { location: `${env.other.origin}/forbidden` },
    });
    env.fixture.pages.set(
        "/jump",
        html(`<script>setTimeout(() => { location.href = ${JSON.stringify(`${env.other.origin}/forbidden`)}; }, 2000);</script>`),
    );
});

afterAll(async () => {
    await env?.stop();
});

async function settled(tab: string): Promise<void> {
    await eventually(async () => {
        const info = await env.ok("page_info", { tab });

        return JSON.stringify(info).includes("localhost") ? true : undefined;
    });
}

describe.skipIf(!present)("allowed domains in a real browser", () => {
    it("lists a popup after a real redirect to a forbidden domain without claiming it", async () => {
        env.fixture.pages.set("/popup-redirect-opener", html("<button onclick=\"window.open('/redirect')\">Open</button>"));
        const tab = await env.open("/popup-redirect-opener");

        await env.ok("input_click", { tab, target: { selector: "button" } });
        const popup = await eventually(async () => {
            const result = await env.ok("popup_list", { tab });
            const found = (result.popups as Array<{ tab: string; url: string; owned: boolean }>)[0];

            return found?.url.startsWith(env.other.origin) ? found : undefined;
        });

        expect(popup.owned).toBe(false);
        const selected = await env.call("select_tab", { tab: popup.tab });

        expect(selected.isError).toBe(false);
        const mutation = await env.call("input_key", { tab: popup.tab, key: "Enter" });

        expect(mutation.isError).toBe(true);
        expect(mutation.text).toContain("localhost");
    });

    it("refuses listener inspection in a forbidden cross-site frame", async () => {
        const tab = await env.open("/nested");

        await eventually(async () => {
            const snapshot = await env.ok("dom_snapshot", { tab });

            return (snapshot.frames as Array<{ isolated: boolean }>).some((frame) => frame.isolated)
                ? true : undefined;
        });
        const result = await env.call("event_listeners", {
            tab, target: { selector: "iframe", frame: "iframe[name=wrap]" },
        });

        expect(result.isError).toBe(true);
        expect(result.text).toContain("localhost");
    });

    it("reports a redirect to a forbidden host and parks the tab on about:blank", async () => {
        const tab = await env.open("/a");
        const outcome = await env.call("page_navigate", {
            tab,
            url: `${env.fixture.origin}/redirect`,
        });

        expect(outcome.isError).toBe(true);
        expect(outcome.text).toContain("localhost");
        expect(outcome.text).toContain("about:blank");

        const info = await env.ok("page_info", { tab });

        expect(JSON.stringify(info)).toContain("about:blank");
    });

    it("refuses a new tab whose redirect ends outside the list but keeps the tab open", async () => {
        const opened = await env.ok("new_tab", { url: `${env.fixture.origin}/redirect` });

        expect(String(opened.navigationError)).toContain("localhost");
        expect((opened.tab as { url: string }).url).toBe("about:blank");
    });

    it("refuses mutating tools on a tab that left the list by itself and still reads it", async () => {
        const tab = await env.open("/jump");

        await settled(tab);

        const refused = await env.call("input_key", { tab, key: "Enter" });
        const read = await env.call("page_info", { tab });

        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("localhost");
        expect(read.isError).toBe(false);
    });

    it("refuses to read the cookies of a tab that left the list, and to mock for a host outside it", async () => {
        const tab = await env.open("/jump");

        await settled(tab);

        const cookies = await env.call("storage_read", { tab, kind: "cookies" });

        expect(cookies.isError).toBe(true);
        expect(cookies.text).toContain("localhost");

        const inside = await env.open("/a");
        const allowed = await env.call("storage_read", { tab: inside, kind: "cookies" });
        const mockOutside = await env.call("network_mock", {
            tab   : inside,
            action: "add",
            rule  : { urlPattern: `${env.other.origin}/*`, response: { status: 200, body: "x" } },
        });
        const mockInside = await env.call("network_mock", {
            tab   : inside,
            action: "add",
            rule  : { urlPattern: `${env.fixture.origin}/api/*`, response: { status: 200, body: "x" } },
        });

        expect(allowed.isError).toBe(false);
        expect(mockOutside.isError).toBe(true);
        expect(mockOutside.text).toContain("localhost");
        expect(mockInside.isError).toBe(false);
    });

    it("refuses to go back to a forbidden history entry", async () => {
        const tab = await env.open("/jump");

        await settled(tab);
        await env.ok("page_navigate", { tab, url: `${env.fixture.origin}/b` });

        const back = await env.call("page_navigate", { tab, action: "back" });

        expect(back.isError).toBe(true);
        expect(back.text).toContain("history entry is on localhost");
    });
});

describe.skipIf(!present)("frames under an allowlist in a real browser", () => {
    async function framesOf(tab: string): Promise<Array<{ frameId: string; url: string }>> {
        const snapshot = await env.ok("dom_snapshot", { tab });

        return snapshot.frames as Array<{ frameId: string; url: string }>;
    }

    it("refuses a click in a frame that inherits its origin from a frame that is not allowed", async () => {
        const tab = await env.open("/nested");
        const nested = await eventually(async () => {
            const found = (await framesOf(tab)).find((frame) => frame.url === "about:srcdoc");

            return found;
        });
        const result = await env.call("click", {
            tab,
            target: { selector: "#sb", frame: nested.frameId },
        });

        expect(result.isError).toBe(true);
        expect(result.text).toContain("localhost");
        expect(env.other.hits.get("/clicked-nested") ?? 0).toBe(0);
    });

    it("lets a frame be named by an iframe selector when its origin is allowed", async () => {
        const tab = await env.open("/nested");

        await eventually(async () => ((await framesOf(tab)).length >= 3 ? true : undefined));

        const result = await env.call("click", {
            tab,
            target: { selector: "#ib", frame: "iframe[name=same]" },
        });

        expect(result.isError).toBe(false);
        await eventually(() => (env.fixture.hits.get("/clicked-same") ?? 0) >= 1 || undefined);
    });

    it("refuses a frame named by a selector when its origin is not allowed", async () => {
        const tab = await env.open("/nested");

        await eventually(async () => ((await framesOf(tab)).length >= 3 ? true : undefined));

        const result = await env.call("click", {
            tab,
            target: { selector: "iframe", frame: "iframe[name=wrap]" },
        });

        expect(result.isError).toBe(true);
        expect(result.text).toContain("localhost");
    });

    it("refuses to read the style or the snapshot of an element in a frame that is not allowed", async () => {
        const tab = await env.open("/nested");

        await eventually(async () => ((await framesOf(tab)).length >= 3 ? true : undefined));

        const target = { selector: "iframe", frame: "iframe[name=wrap]" };
        const style = await env.call("css_inspect", { tab, target });
        const snapshot = await env.call("dom_snapshot", { tab, root: target });

        expect(style.isError).toBe(true);
        expect(snapshot.isError).toBe(true);
    });
});
