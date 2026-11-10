import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config/index.js";
import { createMcpServer, registerServerTools } from "../src/mcp/index.js";
import { allTools, selectTools, TOOL_GROUPS } from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

const names = (tools: Array<{ name: string }>) => tools.map((tool) => tool.name);

describe("selectTools", () => {
    it("keeps every tool when nothing is chosen", () => {
        expect(selectTools(allTools, {})).toHaveLength(allTools.length);
        expect(selectTools(allTools, { tools: [], excludeTools: [] })).toHaveLength(
            allTools.length,
        );
    });

    it("keeps the named tools and groups in the order of the registry", () => {
        const chosen = selectTools(allTools, { tools: ["screenshot", "tabs"] });

        expect(names(chosen)).toEqual(
            allTools
                .map((tool) => tool.name)
                .filter((name) => name === "screenshot" || TOOL_GROUPS.tabs?.includes(name)),
        );
    });

    it("removes the excluded tools and groups after the chosen ones", () => {
        const chosen = selectTools(allTools, {
            tools       : ["inspection", "input"],
            excludeTools: ["js_evaluate", "dom_edit", "css_edit", "emulation"],
        });

        expect(names(chosen)).not.toContain("js_evaluate");
        expect(names(chosen)).not.toContain("dom_edit");
        expect(names(chosen)).toContain("dom_snapshot");
        expect(names(chosen)).toContain("input_click");
    });

    it("has a slim group of a few tools without the risky ones", () => {
        const slim = names(selectTools(allTools, { tools: ["slim"] }));

        expect(slim.length).toBeLessThan(20);
        expect(slim).toEqual(expect.arrayContaining(["new_tab", "dom_snapshot", "click", "screenshot"]));
        expect(slim).not.toContain("js_evaluate");
        expect(slim).not.toContain("storage_write");
    });

    it("names every tool of every group, so a renamed tool cannot slip out of a group", () => {
        const all = new Set(names(allTools));

        for (const [group, members] of Object.entries(TOOL_GROUPS)) {
            for (const member of members) expect(all.has(member), `${group}: ${member}`).toBe(true);
        }
    });

    it("covers every tool with one of the topic groups", () => {
        const covered = new Set(
            Object.entries(TOOL_GROUPS)
                .filter(([group]) => group !== "slim")
                .flatMap(([, members]) => members),
        );

        expect(names(allTools).filter((name) => !covered.has(name))).toEqual([]);
    });

    it("refuses an unknown name with the lists of tools and groups", () => {
        expect(() => selectTools(allTools, { tools: ["clik"] })).toThrow(ConfigError);
        expect(() => selectTools(allTools, { excludeTools: ["nope"] })).toThrow(/unknown tool or group "nope"/);
        expect(() => selectTools(allTools, { tools: ["clik"] })).toThrow(/groups: tabs, pages/);
    });

    it("refuses a selection that leaves no tool", () => {
        expect(() => selectTools(allTools, { tools: ["tabs"], excludeTools: ["tabs"] })).toThrow(
            /no tool is left/,
        );
    });
});

describe("tool selection in the configuration", () => {
    const load = (argv: string[], env: NodeJS.ProcessEnv = {}) =>
        loadConfig({ argv, env, platform: "linux", homedir: "/h", readFile: () => undefined });

    it("reads the lists from the flags and the environment, flags last", () => {
        const config = load(["--exclude-tools=js_evaluate, storage_write"], {
            CHROMIUM_DEVTOOLS_MCP_TOOLS        : "slim",
            CHROMIUM_DEVTOOLS_MCP_EXCLUDE_TOOLS: "pwa_info",
        });

        expect(config.tools).toEqual(["slim"]);
        expect(config.excludeTools).toEqual(["js_evaluate", "storage_write"]);
    });

    it("leaves the lists unset by default", () => {
        const config = load([]);

        expect(config.tools).toBeUndefined();
        expect(config.excludeTools).toBeUndefined();
    });
});

async function listed(config: typeof managedConfig): Promise<string[]> {
    const server = createMcpServer("1.0.0");
    const fake = new FakeAccess();

    registerServerTools(server, config, {} as never, { access: fake.asAccess() });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });

    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    return (await client.listTools()).tools.map((tool) => tool.name);
}

describe("the server with a tool selection", () => {
    it("lists only the chosen tools and cannot call one that is left out", async () => {
        const config = { ...managedConfig, tools: ["pages"], excludeTools: ["page_pdf"] };
        const server = createMcpServer("1.0.0");
        const fake = new FakeAccess();

        registerServerTools(server, config, {} as never, { access: fake.asAccess() });

        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "t", version: "1" });

        await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

        const tools = (await client.listTools()).tools.map((tool) => tool.name);

        expect([...tools].sort()).toEqual(
            ["page_dialogs", "page_extract", "page_info", "page_metrics", "page_navigate", "page_wait"],
        );
        await expect(client.callTool({ name: "click", arguments: {} })).resolves.toMatchObject({
            isError: true,
        });
    });

    it("offers only the resources whose tools are on", async () => {
        const server = createMcpServer("1.0.0");
        const fake = new FakeAccess({
            tabs: [{ targetId: "t1", url: "https://a.example/", title: "", owned: true, created: true }],
        });
        const config = { ...managedConfig, tools: ["tabs", "console_logs"] };

        registerServerTools(server, config, {} as never, { access: fake.asAccess() });

        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "t", version: "1" });

        await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

        const templates = (await client.listResourceTemplates()).resourceTemplates;

        expect(templates.map((template) => template.uriTemplate)).toEqual([
            "browser://tab/{tab}/console",
        ]);
    });

    it("fails to start with an unknown tool name", async () => {
        await expect(listed({ ...managedConfig, tools: ["clik"] })).rejects.toThrow(ConfigError);
    });
});
