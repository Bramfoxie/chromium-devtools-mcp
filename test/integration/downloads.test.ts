import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;

interface Item {
    id      : string;
    filename: string;
    state   : string;
    path?   : string;
}

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    env.fixture.pages.set(
        "/dl",
        html(`<a id="one" href="/file.txt" download="hello.txt">one</a>
<a id="two" href="/file2.txt" download="second.txt">two</a>`),
    );
    env.fixture.pages.set("/file.txt", {
        body  : "hello from the server",
        status: 200,
        type  : "application/octet-stream",
    });
    env.fixture.pages.set("/file2.txt", {
        body  : "second file",
        status: 200,
        type  : "application/octet-stream",
    });
});

afterAll(async () => {
    await env?.stop();
});

describe.skipIf(!present)("downloads in a real browser", () => {
    it("saves a downloaded file into the private directory and waits for it", async () => {
        const tab = await env.open("/dl");
        const allowed = (await env.ok("downloads", { tab, action: "allow" })) as { directory: string };

        expect(allowed.directory.startsWith(env.artifactsDir)).toBe(true);

        await env.ok("input_click", { tab, target: { selector: "#one" } });

        const waited = (await env.ok("downloads", { tab, action: "wait", timeoutMs: 20_000 })) as {
            met     : boolean;
            download: Item;
        };

        expect(waited.met).toBe(true);
        expect(waited.download).toMatchObject({ filename: "hello.txt", state: "completed" });
        expect(waited.download.path?.startsWith(allowed.directory)).toBe(true);
        expect(await readFile(String(waited.download.path), "utf8")).toBe("hello from the server");

        await env.ok("input_click", { tab, target: { selector: "#two" } });

        const second = (await env.ok("downloads", { tab, action: "wait", timeoutMs: 20_000 })) as {
            download: Item;
        };

        expect(second.download.filename).toBe("second.txt");
        expect(await readFile(String(second.download.path), "utf8")).toBe("second file");

        const listed = (await env.ok("downloads", { tab, action: "list" })) as { downloads: Item[] };

        expect(listed.downloads.map((item) => item.filename)).toEqual(["hello.txt", "second.txt"]);
    });

    it("stops saving files once downloads are denied", async () => {
        const tab = await env.open("/dl");

        await env.ok("downloads", { tab, action: "allow" });
        await env.ok("downloads", { tab, action: "deny" });
        await env.ok("input_click", { tab, target: { selector: "#one" } });
        await new Promise((resolve) => setTimeout(resolve, 1500));

        const listed = (await env.ok("downloads", { tab, action: "list" })) as {
            enabled  : boolean;
            downloads: Item[];
        };

        expect(listed.enabled).toBe(false);
        expect(listed.downloads.filter((item) => item.state === "completed")).toEqual([]);
    });
});
