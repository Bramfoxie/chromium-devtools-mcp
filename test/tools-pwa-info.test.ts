import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { pwaInfo, runTool, ToolRuntime } from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const MANIFEST = {
    url     : "https://a.example/manifest.webmanifest?key=secretkey",
    errors  : [{ message: "Property 'x' ignored.", critical: false, line: 3, column: 7 }],
    data    : JSON.stringify({ name: "Demo App", short_name: "Demo" }),
    parsed  : { scope: "https://a.example/" },
    manifest: {
        name           : "Demo App",
        description    : "A demo",
        display        : "kMinimalUi",
        orientation    : "PORTRAIT",
        startUrl       : "https://a.example/app?token=secret123",
        scope          : "https://a.example/",
        id             : "https://a.example/app",
        themeColor     : "rgba(51,102,153,1)",
        backgroundColor: "rgba(255,255,255,1)",
        lang           : "en",
        icons          : [
            { url: "https://a.example/i.png?sig=hidden456", sizes: "192x192", type: "image/png" },
        ],
        shortcuts                : [{ name: "New", url: "https://a.example/new" }],
        preferRelatedApplications: false,
    },
};

interface Answers {
    manifest?      : unknown;
    installability?: unknown;
    appId?         : unknown;
    workers?       : unknown;
    fail?          : string[];
}

function setup(answers: Answers = {}, config: Config = managedConfig) {
    const fake = new FakeAccess({
        tabs: [{ targetId: "tab1", url: "https://a.example/", title: "t", owned: true, created: true }],
    });

    fake.respond = (_tab, method) => {
        if ((answers.fail ?? []).includes(method)) throw new Error(`${method} failed`);

        switch (method) {
            case "Page.getAppManifest":
                return answers.manifest ?? MANIFEST;

            case "Page.getInstallabilityErrors":
                return answers.installability ?? { installabilityErrors: [] };

            case "Page.getAppId":
                return answers.appId ?? {
                    appId        : "https://a.example/app",
                    recommendedId: "/app?token=secret123",
                };

            case "Runtime.evaluate":
                return {
                    result: {
                        value: answers.workers ?? [
                            { scope: "https://a.example/", script: "https://a.example/sw.js?sig=secret789", state: "activated" },
                        ],
                    },
                };

            default:
                return {};
        }
    };

    const runtime = new ToolRuntime({ access: fake.asAccess(), config });

    runtime.tabs.select("tab1");

    return { fake, runtime };
}

const text = (result: { content: unknown }) => JSON.stringify(result.content);

describe("pwa_info", () => {
    it("reports the manifest, the app id and the service workers of an installable page", async () => {
        const { runtime } = setup();
        const result = await runTool(pwaInfo, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            tab        : "tab1",
            installable: true,
            manifest   : {
                name                     : "Demo App",
                shortName                : "Demo",
                description              : "A demo",
                display                  : "minimal-ui",
                orientation              : "portrait",
                scope                    : "https://a.example/",
                themeColor               : "rgba(51,102,153,1)",
                backgroundColor          : "rgba(255,255,255,1)",
                lang                     : "en",
                icons                    : [{ sizes: "192x192", type: "image/png" }],
                shortcuts                : [{ name: "New", url: "https://a.example/new" }],
                preferRelatedApplications: false,
            },
            manifestErrors: [{ message: "Property 'x' ignored.", critical: false, line: 3, column: 7 }],
            serviceWorkers: [{ scope: "https://a.example/", state: "activated" }],
        });
    });

    it("redacts secrets in every address it returns", async () => {
        const { runtime } = setup();
        const result = await runTool(pwaInfo, {}, extra(), runtime);
        const json = text(result);

        for (const secret of ["secretkey", "secret123", "hidden456", "secret789"]) {
            expect(json).not.toContain(secret);
        }

        expect(result.structuredContent).toMatchObject({ appId: { id: "https://a.example/app" } });
    });

    it("says why a page cannot be installed, with a message for each known problem", async () => {
        const { runtime } = setup({
            installability: {
                installabilityErrors: [
                    { errorId: "no-manifest", errorArguments: [] },
                    { errorId: "manifest-missing-suitable-icon", errorArguments: [{ name: "minimum-icon-size-in-pixels", value: "144" }] },
                    { errorId: "something-new", errorArguments: [] },
                ],
            },
        });
        const result = await runTool(pwaInfo, {}, extra(), runtime);
        const output = result.structuredContent as {
            installable         : boolean;
            installabilityErrors: Array<{ id: string; message: string; arguments?: string[] }>;
        };

        expect(output.installable).toBe(false);
        expect(output.installabilityErrors).toEqual([
            { id: "no-manifest", message: "The page has no web app manifest." },
            {
                id       : "manifest-missing-suitable-icon",
                message  : expect.stringContaining("no suitable icon"),
                arguments: ["minimum-icon-size-in-pixels=144"],
            },
            { id: "something-new", message: "Chrome reports the installability problem something-new." },
        ]);
    });

    it("leaves the manifest out for a page that has none", async () => {
        const { runtime } = setup({
            manifest      : { url: "", errors: [], data: "", parsed: { scope: "https://a.example/" }, manifest: { id: "https://a.example/", scope: "https://a.example/" } },
            installability: { installabilityErrors: [{ errorId: "no-manifest", errorArguments: [] }] },
            appId         : {},
            workers       : [],
        });
        const result = await runTool(pwaInfo, {}, extra(), runtime);
        const output = result.structuredContent as Record<string, unknown>;

        expect(output).toMatchObject({
            installable   : false,
            serviceWorkers: [],
            manifestErrors: [],
        });
        expect(output).not.toHaveProperty("manifest");
        expect(output).not.toHaveProperty("manifestUrl");
        expect(output).not.toHaveProperty("appId");
    });

    it("does not call a page installable when Chrome did not answer the installability question", async () => {
        const { runtime } = setup({ fail: ["Page.getInstallabilityErrors"] });
        const result = await runTool(pwaInfo, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            installable         : false,
            installabilityErrors: [],
        });
    });

    it("copes with answers it cannot read and with a page that has no service worker api", async () => {
        const { runtime } = setup({
            manifest: "nonsense",
            appId   : { appId: 5 },
            workers : "none",
        });
        const result = await runTool(pwaInfo, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            manifestErrors: [],
            serviceWorkers: [],
        });
        expect(result.structuredContent).not.toHaveProperty("manifest");

        const none = setup({ fail: ["Runtime.evaluate", "Page.getAppManifest", "Page.getAppId"] });
        const empty = await runTool(pwaInfo, {}, extra(), none.runtime);

        expect(empty.isError).not.toBe(true);
    });

    it("cuts long lists and texts", async () => {
        const icons = Array.from({ length: 30 }, (_, index) => ({ url: `https://a.example/${index}.png` }));
        const workers = Array.from({ length: 15 }, (_, index) => ({
            scope : `https://a.example/${index}/`,
            script: "https://a.example/sw.js",
            state : "activated",
        }));
        const { runtime } = setup({
            manifest: { ...MANIFEST, manifest: { ...MANIFEST.manifest, icons, description: "d".repeat(500) } },
            workers,
        });
        const output = (await runTool(pwaInfo, {}, extra(), runtime)).structuredContent as {
            manifest      : { icons: unknown[]; description: string };
            serviceWorkers: unknown[];
        };

        expect(output.manifest.icons).toHaveLength(20);
        expect(output.manifest.description).toHaveLength(303);
        expect(output.serviceWorkers).toHaveLength(10);
    });

    it("is a reading tool that works in read-only mode and installs nothing", async () => {
        const readOnly: Config = {
            ...managedConfig,
            safety: { ...managedConfig.safety, readOnly: true },
        };
        const { fake, runtime } = setup({}, readOnly);
        const result = await runTool(pwaInfo, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(fake.sent.map((call) => call.method).filter((method) => method.startsWith("PWA."))).toEqual([]);
        expect(fake.sent.map((call) => call.method)).toEqual(
            expect.arrayContaining(["Page.getAppManifest", "Page.getInstallabilityErrors", "Page.getAppId"]),
        );
    });
});
