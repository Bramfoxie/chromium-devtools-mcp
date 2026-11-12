import { readFile, stat } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeLighthouseTools } from "../../src/tools/index.js";
import { chromeAvailable, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
const installed = await nodeLighthouseTools(process.env, process.platform, () => undefined).find();
let env: Env;
let bare: Env;
let guarded: Env;

const PAGE = `<!doctype html><html><head><title>Audit me</title></head><body>
<img src="/missing.png"><button></button><a href="#">click</a>
<p style="color:#ccc;background:#fff">low contrast text</p></body></html>`;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv();
    bare = await startEnv(
        undefined,
        false,
        undefined,
        nodeLighthouseTools({ PATH: "" }, process.platform, () => undefined),
    );
    guarded = await startEnv({
        readOnly            : false,
        allowedDomains      : ["127.0.0.1"],
        deniedDomains       : [], allowPrivateNetworks: true, confirmDangerous    : false,
        uploadDirs          : [],
    });

    for (const target of [env, bare, guarded]) {
        target.fixture.pages.set("/audit", { body: PAGE, status: 200, type: "text/html" });
    }
});

afterAll(async () => {
    await env?.stop();
    await bare?.stop();
    await guarded?.stop();
});

type Audit = {
    version    : string;
    url        : string;
    device     : string;
    scores     : Array<{ category: string; score?: number }>;
    failed     : Array<{ id: string; nodes: Array<{ selector?: string }>; categories: string[] }>;
    failedCount: number;
    reports    : { json: string; html: string };
};

describe.skipIf(!present)("lighthouse_audit in a real browser", () => {
    it.skipIf(installed === undefined)("audits the page of the tab with the installed Lighthouse", async () => {
        const tab = await env.open("/audit");
        const result = (await env.ok("lighthouse_audit", { tab })) as unknown as Audit;

        expect(result.url).toBe(`${env.fixture.origin}/audit`);
        expect(result.device).toBe("desktop");
        expect(result.scores.map((entry) => entry.category).sort()).toEqual([
            "accessibility",
            "best-practices",
            "seo",
        ]);
        expect(result.scores.find((entry) => entry.category === "accessibility")?.score).toBeLessThan(100);

        const ids = result.failed.map((audit) => audit.id);

        expect(ids).toEqual(expect.arrayContaining(["button-name", "image-alt"]));
        expect(result.failed.find((audit) => audit.id === "button-name")?.nodes[0]?.selector).toBe(
            "body > button",
        );
        expect(result.reports.json.startsWith(env.artifactsDir)).toBe(true);
        expect(JSON.parse(await readFile(result.reports.json, "utf8")).lighthouseVersion).toBe(result.version);
        expect((await stat(result.reports.html)).size).toBeGreaterThan(1000);
    }, 120_000);

    it.skipIf(installed === undefined)("audits a given address with the chosen categories and device", async () => {
        const result = (await env.ok("lighthouse_audit", {
            url       : `${env.fixture.origin}/audit`,
            categories: ["seo"],
            device    : "mobile",
        })) as unknown as Audit;

        expect(result.device).toBe("mobile");
        expect(result.scores.map((entry) => entry.category)).toEqual(["seo"]);
    }, 120_000);

    it("tells the agent to ask the user to install Lighthouse when it is missing", async () => {
        const tab = await bare.open("/audit");
        const result = await bare.call("lighthouse_audit", { tab });

        expect(result.isError).toBe(true);
        expect(result.text).toContain("npm install -g lighthouse");
        expect(result.text).toContain("Ask the user");
    });

    it("refuses an address outside allowedDomains and a page that is not http", async () => {
        const outside = await guarded.call("lighthouse_audit", { url: "https://evil.example/" });

        expect(outside.isError).toBe(true);
        expect(outside.text).toContain("evil.example");

        const tab = await env.open("/audit");

        await env.ok("page_navigate", { tab, url: "about:blank" });
        const blank = await env.call("lighthouse_audit", { tab });

        expect(blank.isError).toBe(true);
    });
});
