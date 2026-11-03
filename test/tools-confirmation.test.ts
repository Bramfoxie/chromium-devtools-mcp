import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import {
    allTools,
    runTool,
    ToolRuntime,
} from "../src/tools/index.js";
import {
    type ConfirmOutcome,
    type ConfirmRequest,
    elicitationConfirmer,
} from "../src/tools/confirmation.js";
import { toolAnnotations } from "../src/tools/registry.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const confirming: Config = {
    ...managedConfig,
    safety: { ...managedConfig.safety, confirmDangerous: true },
};

function tool(name: string) {
    const found = allTools.find((known) => known.name === name);

    if (found === undefined) throw new Error(`Unknown tool ${name}`);

    return found;
}

function setup(config: Config, outcome?: ConfirmOutcome) {
    const fake = new FakeAccess({ tabs: [{ targetId: "tab1", url: "https://a.test/", title: "t", owned: true, created: true }] });
    const asked: ConfirmRequest[] = [];
    const runtime = new ToolRuntime({
        access: fake.asAccess(),
        config,
        ...(outcome === undefined
            ? {}
            : {
                confirm: async (request: ConfirmRequest) => {
                    asked.push(request);

                    return outcome;
                },
            }),
    });

    runtime.tabs.select("tab1");

    return { fake, runtime, asked };
}

const DANGEROUS: Array<[string, Record<string, unknown>]> = [
    ["js_evaluate", { expression: "document.cookie" }],
    ["page_wait", { expression: "true" }],
    ["storage_read", { kind: "cookies" }],
    ["storage_write", { kind: "cookies", action: "clear", confirm: true }],
    ["input_upload", { target: { selector: "input" }, files: ["/tmp/a.png"] }],
];

const SAFE: Array<[string, Record<string, unknown>]> = [
    ["storage_read", { kind: "local" }],
    ["page_wait", { selector: "body", timeoutMs: 1 }],
    ["list_tabs", {}],
];

describe("confirmation of dangerous tools", () => {
    it.each(DANGEROUS)("refuses %s when the client cannot ask", async (name, args) => {
        const { fake, runtime } = setup(confirming);
        const result = await runTool(tool(name), args, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("safety.confirmDangerous");
        expect(fake.sent).toEqual([]);
    });

    it.each(DANGEROUS)("asks before %s when the user accepts", async (name, args) => {
        const { runtime, asked } = setup(confirming, "accepted");

        await runTool(tool(name), args, extra(), runtime);

        expect(asked.map((request) => request.tool)).toEqual([name]);
    });

    it.each(["declined", "failed"] as const)("does not run the tool when the answer is %s", async (outcome) => {
        const { fake, runtime } = setup(confirming, outcome);
        const result = await runTool(tool("js_evaluate"), { expression: "1" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(fake.sent).toEqual([]);
    });

    it.each(SAFE)("does not ask for %s", async (name, args) => {
        const { runtime, asked } = setup(confirming, "declined");
        const result = await runTool(tool(name), args, extra(), runtime);

        expect(asked).toEqual([]);
        expect(JSON.stringify(result.content)).not.toContain("confirm");
    });

    it("marks the calls of a confirmed tool as confirmed for the daemon", async () => {
        const { fake, runtime } = setup(confirming, "accepted");

        await runTool(tool("js_evaluate"), { expression: "1" }, extra(), runtime);

        const evaluated = fake.sent.filter((call) => call.method === "Runtime.evaluate");

        expect(evaluated.length).toBeGreaterThan(0);
        expect(evaluated.every((call) => call.confirmed === true)).toBe(true);
    });

    it("does not ask and sends no confirmation when the option is off", async () => {
        const { fake, runtime, asked } = setup(managedConfig, "declined");

        await runTool(tool("js_evaluate"), { expression: "1" }, extra(), runtime);

        expect(asked).toEqual([]);
        expect(fake.sent.length).toBeGreaterThan(0);
        expect(fake.sent.some((call) => call.confirmed === true)).toBe(false);
    });

    it("keeps cookie values and file contents out of the question and the refusal", async () => {
        const { runtime, asked } = setup(confirming, "declined");
        const args = {
            kind   : "cookies",
            action : "set",
            cookies: [{ name: "sid", value: "TOP-SECRET-VALUE" }],
        };
        const result = await runTool(tool("storage_write"), args, extra(), runtime);

        expect(JSON.stringify(asked)).not.toContain("TOP-SECRET-VALUE");
        expect(JSON.stringify(result)).not.toContain("TOP-SECRET-VALUE");
        expect(asked[0]?.summary).toBe("It will set cookies of the page origin.");
    });

    it("shows the script of js_evaluate in the question", async () => {
        const { runtime, asked } = setup(confirming, "declined");

        await runTool(tool("js_evaluate"), { expression: "fetch('/x')" }, extra(), runtime);

        expect(asked[0]?.summary).toContain("fetch('/x')");
    });
});

describe("tool annotations", () => {
    it("marks scripting and cookie tools as destructive and conditional tools as possibly mutating", () => {
        expect(toolAnnotations(tool("js_evaluate"))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        expect(toolAnnotations(tool("storage_read"))).toMatchObject({ readOnlyHint: true, destructiveHint: true });
        expect(toolAnnotations(tool("page_wait"))).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        expect(toolAnnotations(tool("network_mock"))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
        expect(toolAnnotations(tool("list_tabs"))).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        expect(toolAnnotations(tool("close_tab")).destructiveHint).toBe(false);
        expect(toolAnnotations(tool("input_click")).destructiveHint).toBe(false);
    });
});

describe("elicitationConfirmer", () => {
    interface FakeServer {
        getClientCapabilities(): { elicitation?: object } | undefined;
        elicitInput(params: unknown, options?: unknown): Promise<{ action: string }>;
    }

    const request = { tool: "js_evaluate", summary: "It runs a script." };
    const signal = new AbortController().signal;
    const asServer = (server: FakeServer) => server as unknown as Server;

    it("reports unsupported without the elicitation capability", async () => {
        const confirm = elicitationConfirmer(asServer({
            getClientCapabilities: () => ({}),
            elicitInput          : () => Promise.reject(new Error("must not be called")),
        }));

        await expect(confirm(request, signal)).resolves.toBe("unsupported");
    });

    it("maps accept, decline, cancel and failure", async () => {
        const answer = (action: string | Error) =>
            elicitationConfirmer(asServer({
                getClientCapabilities: () => ({ elicitation: {} }),
                elicitInput          : () =>
                    action instanceof Error ? Promise.reject(action) : Promise.resolve({ action }),
            }));

        await expect(answer("accept")(request, signal)).resolves.toBe("accepted");
        await expect(answer("decline")(request, signal)).resolves.toBe("declined");
        await expect(answer("cancel")(request, signal)).resolves.toBe("declined");
        await expect(answer(new Error("closed"))(request, signal)).resolves.toBe("failed");
    });

    it("sends a form request with the tool and the summary", async () => {
        const seen: unknown[] = [];
        const confirm = elicitationConfirmer(asServer({
            getClientCapabilities: () => ({ elicitation: {} }),
            elicitInput          : (params) => {
                seen.push(params);

                return Promise.resolve({ action: "accept" });
            },
        }));

        await confirm(request, signal);

        expect(seen[0]).toMatchObject({
            mode   : "form",
            message: "Allow js_evaluate? It runs a script.",
        });
    });
});
