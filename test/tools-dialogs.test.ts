import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import {
    assertNoDialog,
    DIALOG_HISTORY_LIMIT,
    DialogState,
    jsEvaluate,
    ToolError,
    ToolRuntime,
} from "../src/tools/index.js";
import { ensureNoDialog } from "../src/tools/dialogs.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

const clock = { now: () => 1_700_000_000_000, sleep: async () => undefined };

function dialogs(fake = new FakeAccess()) {
    const state = new DialogState({ access: fake.asAccess(), clock });

    state.attach();

    return { fake, state };
}

function opening(fake: FakeAccess, tab: string, params: unknown): void {
    fake.emit("cdp.event", { targetId: tab, event: "Page.javascriptDialogOpening", params });
}

function closed(fake: FakeAccess, tab: string): void {
    fake.emit("cdp.event", { targetId: tab, event: "Page.javascriptDialogClosed", params: {} });
}

describe("DialogState", () => {
    it("enables Page and subscribes once per tab", async () => {
        const { fake, state } = dialogs();

        await state.ensure("tab1");
        await state.ensure("tab1");
        expect(state.pageEnabled("tab1")).toBe(true);
        expect(fake.sent.map((call) => call.method)).toEqual(["Page.enable"]);
        expect(fake.subscribed).toEqual([
            { targetId: "tab1", event: "Page.javascriptDialogOpening" },
            { targetId: "tab1", event: "Page.javascriptDialogClosed" },
        ]);
    });

    it("subscribes before enabling Page so an opening event is not missed", async () => {
        const { fake, state } = dialogs();
        const order: string[] = [];
        const send = fake.send.bind(fake);
        const subscribe = fake.subscribe.bind(fake);

        fake.send = async (...args) => {
            order.push(`send:${args[1]}`);

            return send(...args);
        };

        fake.subscribe = async (...args) => {
            order.push(`subscribe:${args[1]}`);

            return subscribe(...args);
        };

        await state.ensure("tab1");
        expect(order).toEqual([
            "subscribe:Page.javascriptDialogOpening",
            "subscribe:Page.javascriptDialogClosed",
            "send:Page.enable",
        ]);
    });

    it("reports a possibly open dialog when Page.enable times out", async () => {
        const { fake, state } = dialogs();

        fake.failSend = () => new RpcError(ErrorCode.cdpTimeout, "timed out");

        const failure = await state.ensure("tab1").catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ToolError);
        expect((failure as Error).message).toContain("dialog may already be open");
        expect(fake.sent[0]?.timeoutMs).toBeGreaterThan(0);
        expect(state.pageEnabled("tab1")).toBe(false);
    });

    it("ensureNoDialog propagates ensure errors except not_found and not_owned", async () => {
        const { fake, state } = dialogs();

        fake.failSend = () => new RpcError(ErrorCode.cdpError, "boom");
        await expect(ensureNoDialog(state, "tab1")).rejects.toThrow("boom");

        fake.failSend = () => new RpcError(ErrorCode.notFound, "gone");
        await expect(ensureNoDialog(state, "tab1")).resolves.toBeUndefined();

        fake.failSend = () => new RpcError(ErrorCode.notOwned, "not yours");
        await expect(ensureNoDialog(state, "tab1")).resolves.toBeUndefined();
    });

    it("records an opening dialog and clears it when closed", () => {
        const { fake, state } = dialogs();

        opening(fake, "tab1", {
            url              : "https://a.example/",
            message          : "hello",
            type             : "alert",
            hasBrowserHandler: false,
            defaultPrompt    : "",
        });
        expect(state.open("tab1")).toEqual({
            type             : "alert",
            message          : "hello",
            url              : "https://a.example/",
            hasBrowserHandler: false,
        });
        closed(fake, "tab1");
        expect(state.open("tab1")).toBeUndefined();
        expect(state.historyOf("tab1")).toEqual([
            {
                type    : "alert",
                message : "hello",
                url     : "https://a.example/",
                resolved: "closed",
                at      : "2023-11-14T22:13:20.000Z",
            },
        ]);
    });

    it("clips long messages and keeps prompts", () => {
        const { fake, state } = dialogs();

        opening(fake, "tab1", {
            url              : "https://a.example/",
            message          : "m".repeat(3000),
            type             : "prompt",
            hasBrowserHandler: true,
            defaultPrompt    : "d".repeat(2500),
        });

        const open = state.open("tab1");

        expect(open?.message).toBe(`${"m".repeat(2000)}...`);
        expect(open?.defaultPrompt).toBe(`${"d".repeat(2000)}...`);
        expect(open?.hasBrowserHandler).toBe(true);
    });

    it("resolves an open dialog and records the action", async () => {
        const { fake, state } = dialogs();

        opening(fake, "tab1", { url: "https://a.example/", message: "go?", type: "confirm" });

        const result = await state.resolve("tab1", true, undefined);

        expect(result).toEqual({ handled: true, stale: false });
        expect(state.open("tab1")).toBeUndefined();
        expect(state.historyOf("tab1")[0]?.resolved).toBe("accept");
        expect(fake.sent.map((call) => call.method)).toContain("Page.handleJavaScriptDialog");
        expect(fake.sent.at(-1)?.params).toEqual({ accept: true });
    });

    it("sends prompt text with accept", async () => {
        const { fake, state } = dialogs();

        opening(fake, "tab1", { url: "https://a.example/", message: "name?", type: "prompt" });
        await state.resolve("tab1", true, "Milana");
        expect(fake.sent.at(-1)?.params).toEqual({ accept: true, promptText: "Milana" });
    });

    it("records one entry when the browser acks the resolve", async () => {
        const { fake, state } = dialogs();

        opening(fake, "tab1", { url: "https://a.example/", message: "go?", type: "confirm" });
        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Page.javascriptDialogClosed",
            params  : {},
        });

        const pending = state.resolve("tab1", true, undefined);

        closed(fake, "tab1");
        await pending;

        expect(state.historyOf("tab1")).toHaveLength(1);
        expect(state.historyOf("tab1")[0]?.resolved).toBe("closed");
    });

    it("is a no op without an open dialog", async () => {
        const { fake, state } = dialogs();
        const result = await state.resolve("tab1", false, undefined);

        expect(result).toEqual({ handled: false, stale: false });
        expect(fake.sent).toEqual([]);
        expect(state.historyOf("tab1")).toEqual([]);
    });

    it("clears a stale record when the browser has no dialog", async () => {
        const { fake, state } = dialogs();

        opening(fake, "tab1", { url: "https://a.example/", message: "gone", type: "alert" });
        fake.failSend = () => new RpcError(ErrorCode.cdpError, "No dialog is showing.");

        const result = await state.resolve("tab1", true, undefined);

        expect(result).toEqual({ handled: false, stale: true });
        expect(state.open("tab1")).toBeUndefined();
        expect(state.historyOf("tab1")[0]?.resolved).toBe("closed");

        assertNoDialog(state, "tab1");
    });

    it("applies the policy to dialogs that open later", async () => {
        const { fake, state } = dialogs();

        state.setPolicy("tab1", "dismiss");
        opening(fake, "tab1", { url: "https://a.example/", message: "bye", type: "beforeunload" });
        await Promise.resolve();
        await Promise.resolve();

        expect(fake.sent.map((call) => call.method)).toEqual(["Page.handleJavaScriptDialog"]);
        expect(fake.sent[0]?.params).toEqual({ accept: false });
        expect(state.open("tab1")).toBeUndefined();
        expect(state.historyOf("tab1")[0]?.resolved).toBe("policy");
    });

    it("keeps the dialog when a policy resolve fails", async () => {
        const { fake, state } = dialogs();

        fake.failSend = () => new RpcError(ErrorCode.cdpError, "No dialog is showing.");
        state.setPolicy("tab1", "accept");
        opening(fake, "tab1", { url: "https://a.example/", message: "x", type: "alert" });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(state.open("tab1")?.message).toBe("x");
        expect(state.historyOf("tab1")).toEqual([]);
    });

    it("caps the history at fifty entries", () => {
        const { fake, state } = dialogs();

        for (let index = 0; index < DIALOG_HISTORY_LIMIT + 5; index += 1) {
            opening(fake, "tab1", {
                url    : "https://a.example/",
                message: `d${index}`,
                type   : "alert",
            });
            closed(fake, "tab1");
        }

        const history = state.historyOf("tab1");

        expect(history).toHaveLength(DIALOG_HISTORY_LIMIT);
        expect(history[0]?.message).toBe("d5");
    });

    it("forgets a tab on close and everything on reset", () => {
        const { fake, state } = dialogs();

        opening(fake, "tab1", { url: "https://a.example/", message: "a", type: "alert" });
        opening(fake, "tab2", { url: "https://b.example/", message: "b", type: "alert" });
        state.forget("tab1");
        expect(state.open("tab1")).toBeUndefined();
        expect(state.open("tab2")?.message).toBe("b");
        state.reset();
        expect(state.open("tab2")).toBeUndefined();
        expect(state.policyOf("tab2")).toBe("none");
    });
});

describe("dialog precondition", () => {
    function runtime(fake: FakeAccess): ToolRuntime {
        return new ToolRuntime({ access: fake.asAccess(), config: managedConfig });
    }

    it("fails fast while a dialog is open instead of touching the page", async () => {
        const fake = new FakeAccess({
            tabs: [
                { targetId: "tab1", url: "https://a.example/", title: "a", owned: true, created: true },
            ],
        });
        const toolRuntime = runtime(fake);
        const context = toolRuntime.context(new AbortController().signal);

        context.tabs.refresh(await fake.listTabs("owned"), "tab1");
        fake.emit = (() => {
            throw new Error("must not emit after attach");
        });
        toolRuntime.dialogs.attach();
        toolRuntime.dialogs.handleCdpEvent({
            targetId: "tab1",
            event   : "Page.javascriptDialogOpening",
            params  : { url: "https://a.example/", message: "stop", type: "alert" },
        });

        await expect(
            jsEvaluate.handler({ expression: "1 + 1" }, context),
        ).rejects.toThrow("page_dialogs");
        expect(fake.sent.map((call) => call.method)).toEqual(["Page.enable"]);
    });

    it("throws a ToolError that names page_dialogs", () => {
        const { state } = dialogs();

        state.handleCdpEvent({
            targetId: "tab1",
            event   : "Page.javascriptDialogOpening",
            params  : { url: "https://a.example/", message: "stop", type: "confirm" },
        });

        try {
            assertNoDialog(state, "tab1");
            expect.unreachable("a dialog must block page scripts");
        } catch (error) {
            expect(error).toBeInstanceOf(ToolError);
            expect(String((error as Error).message)).toContain("page_dialogs");
        }

        assertNoDialog(state, "tab2");
    });
});
