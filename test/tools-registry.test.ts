import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import { createMcpServer } from "../src/mcp/index.js";
import {
    allTools,
    CANCELLED_MESSAGE,
    defineTool,
    registerTools,
    runTool,
    throwIfCancelled,
    ToolRuntime,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function extra(signal?: AbortSignal): Extra {
    return { signal: signal ?? new AbortController().signal } as Extra;
}

function runtime(config: Config = managedConfig, access = new FakeAccess()): ToolRuntime {
    return new ToolRuntime({ access: access.asAccess(), config });
}

const readOnly: Config = {
    ...managedConfig,
    safety: { ...managedConfig.safety, readOnly: true },
};

describe("tool declarations", () => {
    it("declares ten tools with unique names, descriptions and access", () => {
        expect(allTools.map((tool) => tool.name)).toEqual([
            "list_tabs",
            "list_sessions",
            "select_tab",
            "new_tab",
            "close_tab",
            "page_info",
            "page_navigate",
            "js_evaluate",
            "dom_query",
            "dom_snapshot",
        ]);

        for (const tool of allTools) {
            expect(tool.description.length).toBeGreaterThan(0);
            expect(["read", "mutate"]).toContain(tool.access);
        }
    });

    it("marks exactly the state changing tools as mutate", () => {
        const mutate = allTools.filter((tool) => tool.access === "mutate").map((tool) => tool.name);

        expect(mutate.sort()).toEqual([
            "close_tab",
            "js_evaluate",
            "new_tab",
            "page_navigate",
            "select_tab",
        ]);
    });

    it("runs every mutate tool through the safety gate", async () => {
        for (const tool of allTools) {
            const called: string[] = [];
            const probe = defineTool({
                name       : tool.name,
                description: tool.description,
                access     : tool.access,
                input      : z.strictObject({}).passthrough(),
                output     : z.strictObject({ ok: z.boolean() }),
                handler    : async () => {
                    called.push(tool.name);

                    return { ok: true };
                },
            });
            const result = await runTool(probe, {}, extra(), runtime(readOnly));
            const text = JSON.stringify(result.content);

            if (tool.access === "mutate") {
                expect(result.isError).toBe(true);
                expect(text).toContain("read-only mode");
                expect(called).toEqual([]);
            } else {
                expect(result.isError).not.toBe(true);
            }
        }
    });
});

describe("runTool", () => {
    const echo = defineTool({
        name       : "echo",
        description: "Echoes the text back.",
        access     : "read",
        input      : z.strictObject({ text: z.string().min(1) }),
        output     : z.strictObject({ text: z.string() }),
        handler    : async (args) => ({ text: args.text }),
    });

    it("returns structured content with matching JSON text", async () => {
        const result = await runTool(echo, { text: "hi" }, extra(), runtime());

        expect(result.structuredContent).toEqual({ text: "hi" });
        expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ text: "hi" }) }]);
    });

    it("rejects invalid arguments with the tool named", async () => {
        const result = await runTool(echo, { text: 5 }, extra(), runtime());

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("echo");
    });

    it("translates daemon errors into actionable messages", async () => {
        const failing = defineTool({
            name       : "failing",
            description: "Always fails.",
            access     : "read",
            input      : z.strictObject({}),
            output     : z.strictObject({}),
            handler    : async () => {
                throw new RpcError(ErrorCode.notFound, "The tab was closed.");
            },
        });
        const result = await runTool(failing, {}, extra(), runtime());

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("Call list_tabs");
    });

    it("rejects a handler result that does not match the output schema", async () => {
        const broken = defineTool({
            name       : "broken",
            description: "Returns the wrong shape.",
            access     : "read",
            input      : z.strictObject({}),
            output     : z.strictObject({ text: z.string() }),
            handler    : async () => ({ other: 1 }) as unknown as { text: string },
        });
        const result = await runTool(broken, {}, extra(), runtime());

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("invalid result");
    });

    it("refuses cancelled requests before and after the handler", async () => {
        const controller = new AbortController();

        controller.abort();
        expect(() => throwIfCancelled(controller.signal)).toThrow(CANCELLED_MESSAGE);
        const before = await runTool(echo, { text: "hi" }, extra(controller.signal), runtime());

        expect(before.isError).toBe(true);
        expect(JSON.stringify(before.content)).toContain("cancelled");

        const late = new AbortController();
        const slow = defineTool({
            name       : "slow",
            description: "Cancels mid-flight.",
            access     : "read",
            input      : z.strictObject({}),
            output     : z.strictObject({}),
            handler    : async (_args, context) => {
                late.abort();

                throwIfCancelled(context.signal);

                return {};
            },
        });
        const after = await runTool(slow, {}, extra(late.signal), runtime());

        expect(after.isError).toBe(true);
        expect(JSON.stringify(after.content)).toContain("cancelled");
    });
});

describe("tools/list", () => {
    it("lists exactly the ten tools with their schemas", async () => {
        const server = createMcpServer("1.0.0");

        registerTools({ server, tools: allTools, runtime: runtime() });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "test-client", version: "1.0.0" });

        await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
        const listed = await client.listTools();

        expect(listed.tools.map((tool) => tool.name)).toEqual([
            "list_tabs",
            "list_sessions",
            "select_tab",
            "new_tab",
            "close_tab",
            "page_info",
            "page_navigate",
            "js_evaluate",
            "dom_query",
            "dom_snapshot",
        ]);

        for (const tool of listed.tools) {
            expect(tool.description?.length ?? 0).toBeGreaterThan(0);
            expect(tool.inputSchema).toMatchObject({ type: "object" });
            expect(tool.outputSchema).toMatchObject({ type: "object" });
        }

        const select = listed.tools.find((tool) => tool.name === "select_tab");

        expect(select?.inputSchema.required).toEqual(["tab"]);
        await client.close();
        await server.close();
    });

    it("calls a registered tool end to end", async () => {
        const access = new FakeAccess();
        const server = createMcpServer("1.0.0");

        registerTools({ server, tools: allTools, runtime: runtime(managedConfig, access) });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "test-client", version: "1.0.0" });

        await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
        const created = await client.callTool({ name: "new_tab", arguments: {} });
        const structured = created.structuredContent as { tab: { tab: string } };

        expect(structured.tab.tab).toBe("tab1");

        const listed = (await client.callTool({ name: "list_tabs", arguments: {} }))
            .structuredContent as { tabs: Array<{ selected: boolean }> };

        expect(listed.tabs).toHaveLength(1);
        expect(listed.tabs[0]?.selected).toBe(true);
        await client.close();
        await server.close();
    });
});
