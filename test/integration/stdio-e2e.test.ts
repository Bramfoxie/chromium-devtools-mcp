import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable } from "./browser-env.js";

const CLI = path.resolve("dist", "cli.js");
const ready = chromeAvailable() && existsSync(CLI);

let home: string;
let env: Record<string, string>;
let client: Client | undefined;

function isolatedEnv(root: string): Record<string, string> {
    const inherited: Record<string, string> = {};

    for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined) inherited[name] = value;
    }

    // On Windows the browser needs the real profile folders, and the daemon keeps its files under LOCALAPPDATA.
    if (process.platform === "win32") {
        return { ...inherited, LOCALAPPDATA: path.join(root, "local") };
    }

    return {
        ...inherited,
        HOME           : root,
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME  : path.join(root, "data"),
        XDG_RUNTIME_DIR: root,
        TMPDIR         : root,
    };
}

beforeAll(async () => {
    if (!ready) return;

    const base = process.platform === "win32" ? os.tmpdir() : "/tmp";

    home = await mkdtemp(path.join(base, "cdme-"));
    env = isolatedEnv(home);
    client = new Client({ name: "e2e", version: "0.0.0" });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args   : [
            CLI,
            "--mode=managed",
            "--headless",
            `--profile-dir=${path.join(home, "profile")}`,
            "--allow-private-networks",
        ],
        env,
        stderr: "pipe",
    });

    transport.stderr?.on("data", () => undefined);
    await client.connect(transport);
});

afterAll(async () => {
    await client?.close().catch(() => undefined);

    if (ready) {
        spawnSync(process.execPath, [CLI, "daemon", "stop"], { env, timeout: 60_000 });
        await rm(home, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
    }
});

async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await (client as Client).callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>)
        .find((block) => block.type === "text")?.text ?? "";

    return {
        isError: result.isError === true,
        text,
        data   : (result.structuredContent ?? {}) as Record<string, unknown>,
    };
}

describe.runIf(process.env.CI !== undefined && chromeAvailable())("the build for the stdio test", () => {
    it("exists, so the stdio test below does not skip", () => {
        expect(existsSync(CLI)).toBe(true);
    });
});

describe.skipIf(!ready)("the built server over stdio", () => {
    it("lists the tools with their schemas", async () => {
        const listed = await (client as Client).listTools();
        const names = listed.tools.map((tool) => tool.name);

        expect(names.length).toBeGreaterThanOrEqual(49);
        expect(names).toEqual(
            expect.arrayContaining(["new_tab", "dom_snapshot", "input_click", "dom_edit", "perf_trace_stop"]),
        );
        expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
    });

    it("drives a real browser through the daemon the binary started", async () => {
        const opened = await call("new_tab", { url: "about:blank" });

        expect(opened.isError).toBe(false);

        const tab = String((opened.data.tab as { tab: string }).tab);
        const value = await call("js_evaluate", { tab, expression: "6 * 7" });

        expect(value.isError).toBe(false);
        expect((value.data as { value?: unknown }).value).toBe(42);
        expect(JSON.parse(value.text)).toHaveProperty("untrusted");

        const refused = await call("page_navigate", { tab, url: "file:///etc/hosts" });

        expect(refused.isError).toBe(true);

        const closed = await call("close_tab", { tab });

        expect(closed.isError).toBe(false);
    });

    it("answers a bad call with an error result instead of dying", async () => {
        const bad = await call("page_info", { tab: "no-such-tab" });

        expect(bad.isError).toBe(true);
        expect((await call("list_tabs")).isError).toBe(false);
    });
});
