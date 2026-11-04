import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import {
    type ArtifactStore,
    type LighthouseTools,
    lighthouseAudit,
    runTool,
    ToolRuntime,
} from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const DIR = "/data/artifacts/lighthouse-20261103T123456-0123456789ab";

const LHR = JSON.stringify({
    lighthouseVersion: "13.6.0",
    requestedUrl     : "https://a.example/page",
    finalDisplayedUrl: "https://a.example/page",
    configSettings   : { formFactor: "desktop" },
    timing           : { total: 5000 },
    audits           : {
        "image-alt": {
            id              : "image-alt",
            title           : "Images have alt text",
            score           : 0,
            scoreDisplayMode: "binary",
            details         : { items: [{ node: { selector: "img", snippet: "<img>" } }] },
        },
    },
    categories: {
        accessibility: { title: "Accessibility", score: 0.5, auditRefs: [{ id: "image-alt" }] },
    },
});

interface Calls {
    args    : string[][];
    cwd     : string[];
    env     : NodeJS.ProcessEnv[];
    timeouts: number[];
}

function setup(options: {
    tools? : Partial<LighthouseTools>;
    config?: Config;
    tabUrl?: string;
} = {}) {
    const fake = new FakeAccess({
        tabs: [
            {
                targetId: "tab1",
                url     : options.tabUrl ?? "https://a.example/page",
                title   : "t",
                owned   : true,
                created : true,
            },
        ],
    });
    const calls: Calls = { args: [], cwd: [], env: [], timeouts: [] };
    const artifacts: ArtifactStore = {
        write    : () => Promise.reject(new Error("not used")),
        directory: async () => ({
            path  : DIR,
            write : async () => 0,
            remove: async () => undefined,
        }),
    };
    const tools: LighthouseTools = {
        find      : async () => "/usr/local/bin/lighthouse",
        chromePath: () => "/opt/chrome/chrome",
        run       : async (_program, args, cwd, timeoutMs, env) => {
            calls.args.push(args);
            calls.cwd.push(cwd);
            calls.env.push(env);
            calls.timeouts.push(timeoutMs);

            return { ok: true, error: "" };
        },
        read: async () => LHR,
        ...options.tools,
    };
    const runtime = new ToolRuntime({
        access    : fake.asAccess(),
        config    : options.config ?? managedConfig,
        artifacts,
        lighthouse: tools,
    });

    runtime.tabs.select("tab1");

    return { fake, runtime, calls };
}

const text = (result: { content: unknown }) => JSON.stringify(result.content);

describe("lighthouse_audit", () => {
    it("audits the page of the tab with fixed arguments in a private directory", async () => {
        const { runtime, calls } = setup();
        const result = await runTool(lighthouseAudit, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(calls.args[0]).toEqual([
            "https://a.example/page",
            "--output=json",
            "--output=html",
            `--output-path=${path.join(DIR, "report")}`,
            "--quiet",
            "--chrome-flags=--headless=new",
            "--only-categories=accessibility,best-practices,seo",
            "--preset=desktop",
        ]);
        expect(calls.cwd[0]).toBe(DIR);
        expect(calls.timeouts[0]).toBe(120_000);
        expect(calls.env[0]?.CHROME_PATH).toBe("/opt/chrome/chrome");
        expect(result.structuredContent).toMatchObject({
            version    : "13.6.0",
            url        : "https://a.example/page",
            scores     : [{ category: "accessibility", score: 50 }],
            failedCount: 1,
            reports    : { json: path.join(DIR, "report.report.json"), html: path.join(DIR, "report.report.html") },
        });
        expect((result.structuredContent as { failed: Array<{ id: string }> }).failed[0]?.id).toBe(
            "image-alt",
        );
    });

    it("takes an address, categories, a device and a time limit", async () => {
        const { runtime, calls } = setup();

        await runTool(
            lighthouseAudit,
            {
                url       : "https://b.example/x?y=1",
                categories: ["seo", "performance"],
                device    : "mobile",
                timeoutMs : 60_000,
            },
            extra(),
            runtime,
        );

        expect(calls.args[0]?.[0]).toBe("https://b.example/x?y=1");
        expect(calls.args[0]).toContain("--only-categories=seo,performance");
        expect(calls.args[0]).toContain("--form-factor=mobile");
        expect(calls.args[0]).not.toContain("--preset=desktop");
        expect(calls.timeouts[0]).toBe(60_000);
    });

    it("leaves the browser path to Lighthouse when none is known", async () => {
        const { runtime, calls } = setup({ tools: { chromePath: () => undefined } });

        await runTool(lighthouseAudit, {}, extra(), runtime);

        expect(calls.env[0]?.CHROME_PATH).toBe(process.env.CHROME_PATH);
    });

    it("tells the agent to ask the user to install Lighthouse when it is not found", async () => {
        const { runtime, calls } = setup({ tools: { find: async () => undefined } });
        const result = await runTool(lighthouseAudit, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("Ask the user to install it with");
        expect(text(result)).toContain("npm install -g lighthouse");
        expect(calls.args).toEqual([]);
    });

    it.each(["about:blank", "chrome://settings", "file:///etc/hosts", ""])(
        "refuses a tab that shows %s and asks for an address",
        async (tabUrl) => {
            const { runtime, calls } = setup({ tabUrl });
            const result = await runTool(lighthouseAudit, {}, extra(), runtime);

            expect(result.isError).toBe(true);
            expect(text(result)).toContain("http and https pages only");
            expect(calls.args).toEqual([]);
        },
    );

    it.each(["ftp://a.example/", "javascript:alert(1)", "not a url", "--help"])(
        "refuses the address %s",
        async (url) => {
            const { runtime, calls } = setup();
            const result = await runTool(lighthouseAudit, { url }, extra(), runtime);

            expect(result.isError).toBe(true);
            expect(calls.args).toEqual([]);
        },
    );

    it("reports a failed run with its message", async () => {
        const { runtime } = setup({
            tools: { run: async () => ({ ok: false, error: "ERRORED_DOCUMENT_REQUEST" }) },
        });
        const result = await runTool(lighthouseAudit, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("Lighthouse failed: ERRORED_DOCUMENT_REQUEST");
    });

    it("reports a report that is missing or not understood", async () => {
        const missing = setup({
            tools: {
                read: async () => {
                    throw new Error("ENOENT");
                },
            },
        });
        const odd = setup({ tools: { read: async () => "{\"x\":1}" } });
        const broken = setup({ tools: { read: async () => "not json" } });

        expect(text(await runTool(lighthouseAudit, {}, extra(), missing.runtime))).toContain(
            "report could not be read",
        );
        expect(text(await runTool(lighthouseAudit, {}, extra(), odd.runtime))).toContain(
            "format this server does not know",
        );
        expect(text(await runTool(lighthouseAudit, {}, extra(), broken.runtime))).toContain(
            "report could not be read",
        );
    });

    it("limits its inputs", () => {
        const accepts = (value: unknown) => lighthouseAudit.input.safeParse(value).success;

        expect(accepts({ categories: ["seo"], device: "mobile", timeoutMs: 10_000 })).toBe(true);
        expect(accepts({ categories: [] })).toBe(false);
        expect(accepts({ categories: ["pwa"] })).toBe(false);
        expect(accepts({ device: "tablet" })).toBe(false);
        expect(accepts({ timeoutMs: 9999 })).toBe(false);
        expect(accepts({ timeoutMs: 300_001 })).toBe(false);
    });
});

describe("lighthouse_audit and the safety options", () => {
    const restricted: Config = {
        ...managedConfig,
        safety: { ...managedConfig.safety, allowedDomains: ["a.example"] },
    };

    it("is refused in read-only mode", async () => {
        const { runtime, calls } = setup({
            config: { ...managedConfig, safety: { ...managedConfig.safety, readOnly: true } },
        });
        const result = await runTool(lighthouseAudit, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("read-only mode");
        expect(calls.args).toEqual([]);
    });

    it("is refused for an address outside allowedDomains and allowed for one inside", async () => {
        const { runtime, calls } = setup({ config: restricted });
        const refused = await runTool(
            lighthouseAudit,
            { url: "https://evil.example/" },
            extra(),
            runtime,
        );

        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain("evil.example");
        expect(calls.args).toEqual([]);

        const allowed = await runTool(
            lighthouseAudit,
            { url: "https://a.example/ok" },
            extra(),
            runtime,
        );

        expect(allowed.isError).not.toBe(true);
    });

    it("is refused when the page of the tab is outside allowedDomains", async () => {
        const { runtime, calls } = setup({ config: restricted, tabUrl: "https://evil.example/" });
        const result = await runTool(lighthouseAudit, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("evil.example");
        expect(calls.args).toEqual([]);
    });
});
