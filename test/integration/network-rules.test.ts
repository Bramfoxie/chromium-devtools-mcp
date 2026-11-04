import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();

function safety(patch: Partial<Parameters<typeof startEnv>[0] & object>) {
    return {
        readOnly            : false,
        allowedDomains      : [] as string[],
        deniedDomains       : [] as string[],
        allowPrivateNetworks: false,
        confirmDangerous    : false,
        ...patch,
    };
}

function routes(env: Env): void {
    env.fixture.pages.set("/a", html("<p id=a>a</p>"));
    env.other.pages.set("/b", html("<p id=b>b</p>"));
    env.fixture.pages.set("/redirect", {
        body   : "",
        status : 302,
        type   : "text/plain",
        headers: { location: `${env.other.origin}/b` },
    });
}

describe.skipIf(!present)("private networks in a real browser", () => {
    let env: Env;

    beforeAll(async () => {
        env = await startEnv(safety({}));
        routes(env);
    });

    afterAll(async () => {
        await env?.stop();
    });

    it("refuses to open and to navigate to a local address by default", async () => {
        const refused = await env.call("new_tab", { url: `${env.fixture.origin}/a` });

        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("safety.allowPrivateNetworks");

        const blank = (await env.ok("new_tab", { url: "about:blank" })) as { tab: { tab: string } };
        const moved = await env.call("page_navigate", { tab: blank.tab.tab, url: `${env.other.origin}/b` });

        expect(moved.isError).toBe(true);
        expect(moved.text).toContain("safety.allowPrivateNetworks");
    });
});

describe.skipIf(!present)("a host named in allowedDomains on a private network", () => {
    let env: Env;

    beforeAll(async () => {
        env = await startEnv(safety({ allowedDomains: ["127.0.0.1"] }));
        routes(env);
    });

    afterAll(async () => {
        await env?.stop();
    });

    it("opens the named host and refuses another local host", async () => {
        const tab = await env.open("/a");

        expect(tab).toMatch(/./);

        const other = await env.call("page_navigate", { tab, url: `${env.other.origin}/b` });

        expect(other.isError).toBe(true);
        expect(other.text).toContain("safety.allowedDomains");
    });
});

describe.skipIf(!present)("deniedDomains in a real browser", () => {
    let env: Env;

    beforeAll(async () => {
        env = await startEnv(safety({ deniedDomains: ["localhost"], allowPrivateNetworks: true }));
        routes(env);
    });

    afterAll(async () => {
        await env?.stop();
    });

    it("refuses a denied host and parks a tab that a redirect sends there", async () => {
        const refused = await env.call("new_tab", { url: `${env.other.origin}/b` });

        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("safety.deniedDomains");

        const tab = await env.open("/a");
        const redirected = await env.call("page_navigate", { tab, url: `${env.fixture.origin}/redirect` });

        expect(redirected.isError).toBe(true);
        expect(redirected.text).toContain("safety.deniedDomains");
        expect(redirected.text).toContain("about:blank");

        const info = (await env.ok("page_info", { tab })) as { url?: string };

        expect(info.url).toBe("about:blank");
    });
});
