import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, eventually, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv({ readOnly: false, allowedDomains: ["127.0.0.1"], confirmDangerous: false });
    env.fixture.pages.set("/a", html("<p id=a>a</p>"));
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
        html(`<script>setTimeout(() => { location.href = ${JSON.stringify(`${env.other.origin}/forbidden`)}; }, 300);</script>`),
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

    it("refuses to go back to a forbidden history entry", async () => {
        const tab = await env.open("/jump");

        await settled(tab);
        await env.ok("page_navigate", { tab, url: `${env.fixture.origin}/b` });

        const back = await env.call("page_navigate", { tab, action: "back" });

        expect(back.isError).toBe(true);
        expect(back.text).toContain("history entry is on localhost");
    });
});
