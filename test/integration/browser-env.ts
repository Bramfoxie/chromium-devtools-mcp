import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { findBrowserExecutable } from "../../src/browser/discovery.js";
import { connectBrowser } from "../../src/daemon/runner.js";
import type { Config } from "../../src/config/index.js";
import { connectToDaemon, daemonIdentity, type DaemonLayout, runDaemon, type RunningDaemon } from "../../src/daemon/index.js";
import { createMcpServer, DaemonLink, registerServerTools } from "../../src/mcp/index.js";
import { createSocketHarness } from "../helpers/daemon-socket.js";

export function chromeAvailable(): boolean {
    try {
        findBrowserExecutable("chrome");

        return true;
    } catch {
        return false;
    }
}

export type Page = (url: string, body: string, status?: number) => void;

export interface Fixture {
    origin: string;
    pages : Map<
        string,
        { body: string; status: number; type: string; headers?: Record<string, string> }
    >;
    hits: Map<string, number>;
    close(): Promise<void>;
}

export async function startFixture(host: string = "127.0.0.1"): Promise<Fixture> {
    const pages: Fixture["pages"] = new Map();
    const hits = new Map<string, number>();
    const server: Server = createHttpServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");

        hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
        const page = pages.get(url.pathname);

        if (!page) {
            response.writeHead(404).end("not found");

            return;
        }

        response.writeHead(page.status, {
            ...page.headers,
            "content-type": page.type,
            "set-cookie"  : url.pathname === "/cookie" ? "fixture=1; Path=/" : [],
        });
        response.end(page.body);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    return {
        origin: `http://${host}:${port}`,
        pages,
        hits,
        close : () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

export function html(body: string): { body: string; status: number; type: string } {
    return { body: `<!doctype html><meta charset="utf-8"><body>${body}</body>`, status: 200, type: "text/html" };
}

async function freePort(): Promise<number> {
    for (let port = 9400 + Math.floor(Math.random() * 400); ; port += 1) {
        const free = await new Promise<boolean>((resolve) => {
            const probe = createNetServer();

            probe.once("error", () => resolve(false));
            probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
        });

        if (free) return port;
    }
}

export interface ToolOutcome {
    isError: boolean;
    text   : string;
    data   : Record<string, unknown>;
    blocks : Array<{ type: string }>;
}

const LOG_TAIL_CHARS = 4000;

function tail(text: string): string {
    return text.length > LOG_TAIL_CHARS ? text.slice(-LOG_TAIL_CHARS) : text;
}

export interface Env {
    fixture: Fixture;
    other  : Fixture;
    tools(): Promise<unknown>;
    call(name: string, args?: Record<string, unknown>): Promise<ToolOutcome>;
    ok(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
    open(path: string): Promise<string>;
    stop(): Promise<void>;
}

export async function startEnv(safety?: Config["safety"]): Promise<Env> {
    const harness = createSocketHarness();
    const home = await mkdtemp(path.join(os.tmpdir(), "cdm-it-home-"));
    const profile = await mkdtemp(path.join(os.tmpdir(), "cdm-it-profile-"));
    const port = await freePort();
    const fixture = await startFixture();
    const other = await startFixture("localhost");
    const config: Config = {
        browser   : "chrome",
        mode      : "managed",
        headless  : true,
        profileDir: profile,
        debugPort : port,
        allowFocus: false,
        isolated  : true,
        safety    : safety ?? { readOnly: false, allowedDomains: [], confirmDangerous: false },
    };
    const options = await harness.options();
    const tokenDir = await mkdtemp(path.join(home, "token-"));
    const layout: DaemonLayout = {
        tokenFile : path.join(tokenDir, "daemon.token"),
        platform  : options.platform,
        uid       : options.uid,
        socketPath: () => options.socketPath,
        instance  : () => options,
    };
    let daemon: RunningDaemon | undefined;
    let daemonOutcome = "the daemon has not stopped";
    let stderrLog = "";
    const realWrite = process.stderr.write;

    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        stderrLog = tail(stderrLog + String(chunk));

        return (realWrite as (...args: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
    }) as typeof process.stderr.write;
    const diagnostics = () =>
        `\n--- daemon outcome ---\n${daemonOutcome}\n--- daemon and browser messages (last ${LOG_TAIL_CHARS} chars) ---\n${tail(stderrLog)}`;
    const link = new DaemonLink(
        { identity: daemonIdentity(config), isolated: true, safety: config.safety },
        {
            connect    : (expect) => connectToDaemon({ clientName: "it", expect, layout }),
            startDaemon: async () => {
                daemon = await runDaemon(config, {
                    layout,
                    connectBrowser,
                    idleTimeoutMs: 600_000,
                });

                daemonOutcome = "the daemon is running";

                return {
                    exited: daemon.done.then((outcome) => {
                        daemonOutcome = `stopped: ${outcome.reason}${outcome.error ? ` (${outcome.error.message})` : ""}`;
                    }),
                };
            },
            sleep         : (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            now           : () => Date.now(),
            logFile       : path.join(home, "daemon.log"),
            startTimeoutMs: 50_000,
            pollIntervalMs: 100,
        },
    );
    const server = createMcpServer("0.0.0");

    registerServerTools(server, config, link);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "it", version: "0.0.0" });

    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    const call: Env["call"] = async (name, args = {}) => {
        const result = await client.callTool({ name, arguments: args }, undefined, {
            timeout: 120_000,
        });
        const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
        const text = blocks.find((block) => block.type === "text")?.text ?? "";

        return {
            isError: result.isError === true,
            text,
            data   : (result.structuredContent ?? {}) as Record<string, unknown>,
            blocks,
        };
    };
    const ok: Env["ok"] = async (name, args) => {
        const outcome = await call(name, args);

        if (outcome.isError) throw new Error(`${name} failed: ${outcome.text}${diagnostics()}`);

        return outcome.data;
    };

    try {
        await ok("list_tabs");
    } catch (error) {
        process.stderr.write = realWrite;

        throw error;
    }

    return {
        fixture,
        other,
        tools: async () => (await client.listTools()).tools,
        call,
        ok,
        open : async (route) => {
            const tab = await ok("new_tab", { url: `${fixture.origin}${route}` });

            return String((tab.tab as { tab: string }).tab);
        },
        stop: async () => {
            process.stderr.write = realWrite;
            await client.close().catch(() => undefined);
            await server.close().catch(() => undefined);
            await link.close().catch(() => undefined);
            await daemon?.stop().catch(() => undefined);
            await harness.dispose();
            await fixture.close();
            await other.close();
            await rm(profile, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
            await rm(home, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
        },
    };
}

export async function eventually<T>(
    probe: () => Promise<T | undefined> | T | undefined,
    timeoutMs = 10_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        const value = await probe();

        if (value !== undefined && value !== false) return value;

        if (Date.now() > deadline) throw new Error("condition not met before the deadline");

        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}
