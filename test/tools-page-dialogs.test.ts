import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { pageDialogs, runTool, ToolRuntime } from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

function setup(config: Config = managedConfig, access?: FakeAccess) {
    const fake = access ?? new FakeAccess({
        tabs: [
            { targetId: "tab1", url: "https://a.example/", title: "a", owned: true, created: true },
        ],
    });
    const runtime = new ToolRuntime({ access: fake.asAccess(), config });

    runtime.dialogs.attach();

    return { fake, runtime };
}

function select(runtime: ToolRuntime): void {
    runtime.tabs.refresh(
        [{ targetId: "tab1", url: "https://a.example/", title: "a", owned: true, created: true }],
        "tab1",
    );
}

function textOf(result: Awaited<ReturnType<typeof runTool>>): string {
    return JSON.stringify(result.content);
}

describe("page_dialogs", () => {
    it("reports no dialog with an empty history", async () => {
        const { runtime } = setup();

        select(runtime);
        const result = await runTool(pageDialogs, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({
            tab    : "tab1",
            open   : null,
            policy : "none",
            effect : "No dialog is open in this tab.",
            history: [],
        });
    });

    it("reports the open dialog on status", async () => {
        const { fake, runtime } = setup();

        select(runtime);
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Page.javascriptDialogOpening",
            params  : {
                url          : "https://a.example/page",
                message      : "sure?",
                type         : "confirm",
                defaultPrompt: "yes",
            },
        });

        const result = await runTool(pageDialogs, {}, extra(), runtime);

        expect(result.structuredContent).toMatchObject({
            open: {
                type         : "confirm",
                message      : "sure?",
                defaultPrompt: "yes",
                url          : "https://a.example/page",
            },
            effect: "A dialog is open in this tab.",
        });
    });

    it("accepts with prompt text and dismisses", async () => {
        const { fake, runtime } = setup();

        select(runtime);
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Page.javascriptDialogOpening",
            params  : { url: "https://a.example/", message: "name?", type: "prompt" },
        });

        const accepted = await runTool(
            pageDialogs,
            { action: "accept", promptText: "Milana" },
            extra(),
            runtime,
        );

        expect(accepted.structuredContent).toMatchObject({
            open   : null,
            effect : "The dialog was accepted.",
            history: [{ type: "prompt", resolved: "accept" }],
        });
        expect(fake.sent.at(-1)).toMatchObject({
            method: "Page.handleJavaScriptDialog",
            params: { accept: true, promptText: "Milana" },
        });

        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Page.javascriptDialogOpening",
            params  : { url: "https://a.example/", message: "stop?", type: "confirm" },
        });

        const dismissed = await runTool(pageDialogs, { action: "dismiss" }, extra(), runtime);

        expect(dismissed.structuredContent).toMatchObject({
            open  : null,
            effect: "The dialog was dismissed.",
        });
        expect(fake.sent.at(-1)?.params).toEqual({ accept: false });
    });

    it("is a no op without an open dialog", async () => {
        const { runtime } = setup();

        select(runtime);
        const result = await runTool(pageDialogs, { action: "accept" }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({
            open  : null,
            effect: "No dialog is open in this tab. Nothing was done.",
        });
    });

    it("rejects prompt text without accept", async () => {
        const { runtime } = setup();

        select(runtime);
        const result = await runTool(
            pageDialogs,
            { action: "dismiss", promptText: "x" },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("promptText is only accepted with action accept");
    });

    it("stores the policy and applies it to later dialogs", async () => {
        const { fake, runtime } = setup();

        select(runtime);
        const set = await runTool(pageDialogs, { policy: "dismiss" }, extra(), runtime);

        expect(set.structuredContent).toMatchObject({ policy: "dismiss" });
        expect(runtime.dialogs.policyOf("tab1")).toBe("dismiss");

        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Page.javascriptDialogOpening",
            params  : { url: "https://a.example/", message: "bye", type: "beforeunload" },
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(fake.sent.at(-1)?.params).toEqual({ accept: false });

        const status = await runTool(pageDialogs, {}, extra(), runtime);

        expect(status.structuredContent).toMatchObject({
            open   : null,
            history: [{ type: "beforeunload", resolved: "policy" }],
        });
    });

    it("needs a selected tab", async () => {
        const { runtime } = setup();
        const result = await runTool(pageDialogs, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("No tab is selected");
    });

    it("allows status in read-only mode and refuses changes", async () => {
        const readOnly: Config = {
            ...managedConfig,
            safety: { ...managedConfig.safety, readOnly: true },
        };
        const { runtime } = setup(readOnly);

        select(runtime);

        const status = await runTool(pageDialogs, {}, extra(), runtime);

        expect(status.isError).not.toBe(true);

        for (const args of [{ action: "accept" }, { action: "dismiss" }, { policy: "none" }]) {
            const refused = await runTool(pageDialogs, args, extra(), runtime);

            expect(refused.isError).toBe(true);
            expect(textOf(refused)).toContain("read-only mode");
        }
    });
});
