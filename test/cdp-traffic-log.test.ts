import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CdpClient, type Transport } from "../src/cdp/index.js";
import { trafficFile, type TrafficFileIO } from "../src/cdp/traffic-log.js";
import { loadConfig } from "../src/config/index.js";

describe("CDP traffic log", () => {
    it("does not measure message sizes when logging is disabled", async () => {
        let receive: (raw: string) => void = () => undefined;
        const transport: Transport = {
            send: (raw) => {
                const id = (JSON.parse(raw) as { id: number }).id;

                receive(JSON.stringify({ id, result: {} }));
            },
            close    : async () => undefined,
            onMessage: (handler) => { receive = handler; },
            onClose  : () => undefined,
        };
        const client = await CdpClient.connect({ url: "ws://unused", createTransport: async () => transport });
        const measure = vi.spyOn(Buffer, "byteLength");

        try {
            await client.send("Page.enable");
            expect(measure).not.toHaveBeenCalled();
        } finally {
            measure.mockRestore();
            await client.close();
        }
    });

    it("records only method, id, direction and message size", async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "cdm-traffic-"));
        const file = path.join(dir, "traffic.jsonl");
        let receive: (raw: string) => void = () => undefined;
        const transport: Transport = {
            send: (raw) => {
                const id = (JSON.parse(raw) as { id: number }).id;

                receive(JSON.stringify({ id, result: { value: "RESPONSE-SECRET" } }));
                receive(JSON.stringify({ method: "Page.loadEventFired", params: { value: "EVENT-SECRET" } }));
            },
            close    : async () => undefined,
            onMessage: (handler) => { receive = handler; },
            onClose  : () => undefined,
        };

        try {
            const client = await CdpClient.connect({
                url: "ws://unused", createTransport: async () => transport, traffic: trafficFile(file),
            });

            await client.send("Runtime.evaluate", { expression: "REQUEST-SECRET" });
            await client.close();
            const contents = readFileSync(file, "utf8");
            const entries = contents.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

            expect(contents).not.toContain("SECRET");
            expect(entries).toMatchObject([
                { direction: "sent", id: 1, method: "Runtime.evaluate" },
                { direction: "received", id: 1, method: "Runtime.evaluate" },
                { direction: "received", method: "Page.loadEventFired" },
            ]);

            for (const entry of entries) {
                expect(Object.keys(entry).sort()).toEqual(
                    entry.id === undefined ? ["bytes", "direction", "method"] : ["bytes", "direction", "id", "method"],
                );
                expect(entry.bytes).toBeGreaterThan(0);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("does not write to a nonprivate existing file", () => {
        if (process.platform === "win32") return;

        const dir = mkdtempSync(path.join(os.tmpdir(), "cdm-traffic-"));
        const file = path.join(dir, "traffic.jsonl");

        try {
            writeFileSync(file, "keep", { mode: 0o644 });
            chmodSync(file, 0o644);
            trafficFile(file)({ direction: "sent", method: "Page.enable", id: 1, bytes: 10 });
            expect(readFileSync(file, "utf8")).toBe("keep");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("does not follow a symbolic link to an existing file", () => {
        if (process.platform === "win32") return;

        const dir = mkdtempSync(path.join(os.tmpdir(), "cdm-traffic-"));
        const target = path.join(dir, "target");
        const link = path.join(dir, "link");

        try {
            writeFileSync(target, "keep", { mode: 0o600 });
            symlinkSync(target, link);
            trafficFile(link)({ direction: "sent", method: "Page.enable", id: 1, bytes: 10 });
            expect(readFileSync(target, "utf8")).toBe("keep");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("loads an absolute log path from flags or environment", () => {
        const options = { platform: "linux" as const, homedir: "/home/u", readFile: () => undefined };

        expect(loadConfig({ ...options, argv: ["--cdp-log=/tmp/a"], env: {} }).cdpLog).toBe("/tmp/a");
        expect(loadConfig({ ...options, argv: [], env: { CHROMIUM_DEVTOOLS_MCP_CDP_LOG: "/tmp/b" } }).cdpLog).toBe("/tmp/b");
        expect(() => loadConfig({ ...options, argv: ["--cdp-log=relative"], env: {} })).toThrow(/absolute/);
    });

    it.each([
        { platform: "darwin" as const, home: "/Users/u", file: "/tmp/file", env: "/tmp/env", flag: "/tmp/flag" },
        { platform: "linux" as const, home: "/home/u", file: "/tmp/file", env: "/tmp/env", flag: "/tmp/flag" },
        { platform: "win32" as const, home: "C:\\Users\\u", file: "C:\\file", env: "C:\\env", flag: "C:\\flag" },
    ])("uses the highest priority path on $platform", ({ platform, home, file, env, flag }) => {
        const config = loadConfig({
            platform,
            homedir : home,
            readFile: () => JSON.stringify({ cdpLog: file }),
            env     : { CHROMIUM_DEVTOOLS_MCP_CDP_LOG: env },
            argv    : [`--cdp-log=${flag}`],
        });

        expect(config.cdpLog).toBe(flag);
    });

    it.each(["darwin", "linux", "win32"] as const)("writes metadata on %s", (platform) => {
        const lines: string[] = [];
        const io: TrafficFileIO = {
            platform,
            open : () => 4,
            stat : () => ({ isFile: () => true, mode: 0o600 }),
            write: (_fd, line) => { lines.push(line); },
            close: () => undefined,
            warn : () => undefined,
        };

        trafficFile("absolute", io)({ direction: "sent", method: "Network.enable", id: 1, bytes: 5 });
        expect(JSON.parse(lines[0] ?? "")).toEqual({ direction: "sent", method: "Network.enable", id: 1, bytes: 5 });
    });
});
