import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";
import {
    AuditLog,
    type AuditEntry,
    auditLine,
    fileAuditSink,
    pageInfo,
    pageNavigate,
    runTool,
    summarizeArgs,
    ToolRuntime,
} from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

describe("summarizeArgs", () => {
    it("keeps short plain values and drops nothing that is not a secret", () => {
        expect(summarizeArgs({ tab: "t1", limit: 5, clear: true, action: "list" })).toEqual({
            tab   : "t1",
            limit : 5,
            clear : true,
            action: "list",
        });
    });

    it("keeps only the length and a fingerprint of what the agent types or runs", () => {
        const summary = summarizeArgs({
            text      : "my secret text",
            expression: "document.cookie",
            html      : "<p>x</p>",
            promptText: "hi",
            value     : "p4ss",
        });
        const text = JSON.stringify(summary);

        expect(summary.text).toMatch(/^<14 chars, sha256 [0-9a-f]{12}>$/);
        expect(text).not.toContain("my secret text");
        expect(text).not.toContain("document.cookie");
        expect(text).not.toContain("p4ss");
        expect(summarizeArgs({ text: "my secret text" }).text).toBe(summary.text);
    });

    it("redacts values under secret looking names and the secrets in addresses", () => {
        const summary = summarizeArgs({
            password: "hunter2",
            apiToken: "abc",
            cookies : "a=b",
            url     : "https://a.example/p?token=abc123&x=1",
            urlRegex: "https://a\\.example/\\?sid=1",
        });

        expect(summary.password).toBe("<redacted>");
        expect(summary.apiToken).toBe("<redacted>");
        expect(summary.cookies).toBe("<redacted>");
        expect(String(summary.url)).not.toContain("abc123");
        expect(String(summary.url)).toContain("x=1");
    });

    it("walks nested targets and fields, redacting the typed values inside", () => {
        const summary = summarizeArgs({
            target: { selector: "#a", locator: { role: "button", name: "Save" } },
            fields: [{ target: { selector: "input" }, value: "s3cret" }],
        });

        expect(summary.target).toEqual({ selector: "#a", locator: { role: "button", name: "Save" } });
        expect(JSON.stringify(summary)).not.toContain("s3cret");
    });

    it("clips long strings, long lists and deep objects", () => {
        const summary = summarizeArgs({
            selector: "x".repeat(300),
            list    : Array.from({ length: 25 }, (_, index) => index),
            deep    : { a: { b: { c: { d: 1 } } } },
        });

        expect(String(summary.selector).length).toBeLessThan(110);
        expect(summary.list).toHaveLength(11);
        expect((summary.list as unknown[]).at(-1)).toBe("<15 more>");
        expect(JSON.stringify(summary.deep)).toContain("<object>");
    });

    it("gives an empty summary for arguments that are not an object", () => {
        expect(summarizeArgs(undefined)).toEqual({});
        expect(summarizeArgs("x")).toEqual({});
        expect(summarizeArgs([1])).toEqual({});
    });
});

describe("auditLine and AuditLog", () => {
    const entry: AuditEntry = {
        time      : "2026-01-01T00:00:00.000Z",
        tool      : "click",
        args      : { tab: "t1" },
        outcome   : "error",
        error     : "x".repeat(600),
        durationMs: 12,
    };

    it("writes one JSON object per line with the error cut", () => {
        const parsed = JSON.parse(auditLine(entry)) as AuditEntry;

        expect(parsed.tool).toBe("click");
        expect(parsed.error?.length).toBeLessThan(310);
        expect(auditLine(entry)).not.toContain("\n");
    });

    it("never throws when the sink fails and warns only once", () => {
        const warnings: string[] = [];
        const log = new AuditLog(
            { write: () => { throw new Error("disk full"); } },
            (message) => void warnings.push(message),
        );

        log.record(entry);
        log.record(entry);

        expect(warnings).toEqual(["could not write the audit log: disk full"]);
    });
});

describe("audit log of tool calls", () => {
    function setup(config = managedConfig) {
        const lines: string[] = [];
        const fake = new FakeAccess({
            tabs: [{ targetId: "tab1", url: "https://a.example/p?token=zzz", title: "t", owned: true, created: true }],
        });
        const runtime = new ToolRuntime({
            access: fake.asAccess(),
            config,
            audit : new AuditLog({ write: (line) => void lines.push(line) }, () => undefined),
        });

        runtime.attach();
        runtime.tabs.refresh(
            [{ targetId: "tab1", url: "https://a.example/p?token=zzz", title: "t", owned: true, created: true }],
            "tab1",
        );

        return { fake, runtime, lines };
    }

    const parse = (lines: string[]) => lines.map((line) => JSON.parse(line) as AuditEntry);

    it("records a call with its tool, tab, redacted address, summarized arguments and result", async () => {
        const { fake, runtime, lines } = setup();

        fake.respond = () => ({ result: { value: { url: "https://a.example/", title: "t", readyState: "complete" } } });
        await runTool(pageInfo, { tab: "tab1" }, extra(), runtime);

        const [entry] = parse(lines);

        expect(entry).toMatchObject({ tool: "page_info", tab: "tab1", outcome: "ok", args: { tab: "tab1" } });
        expect(entry?.url).toBeDefined();
        expect(entry?.url).not.toContain("zzz");
        expect(typeof entry?.durationMs).toBe("number");
        expect(Date.parse(String(entry?.time))).not.toBeNaN();
    });

    it("records a refusal and an invalid call as errors and keeps secrets out of the line", async () => {
        const readOnly = { ...managedConfig, safety: { ...managedConfig.safety, readOnly: true } };
        const { runtime, lines } = setup(readOnly);

        await runTool(pageNavigate, { url: "https://b.example/?password=hunter2" }, extra(), runtime);
        await runTool(pageNavigate, { url: 5 }, extra(), runtime);

        const entries = parse(lines);

        expect(entries.map((entry) => entry.outcome)).toEqual(["error", "error"]);
        expect(entries[0]?.error).toContain("read-only");
        expect(lines.join("")).not.toContain("hunter2");
    });

    it("writes nothing when no audit log is set", async () => {
        const fake = new FakeAccess();
        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

        runtime.attach();

        await expect(runTool(pageInfo, {}, extra(), runtime)).resolves.toBeDefined();
        expect(runtime.audit).toBeUndefined();
    });
});

describe("fileAuditSink", () => {
    let dir: string | undefined;

    afterEach(async () => {
        if (dir !== undefined) await rm(dir, { recursive: true, force: true });

        dir = undefined;
    });

    it("creates the folder, appends lines and keeps the file private", async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), "cdm-audit-"));

        const file = path.join(dir, "logs", "audit.jsonl");
        const sink = fileAuditSink(file);

        sink.write('{"a":1}\n');
        sink.write('{"a":2}\n');

        expect((await readFile(file, "utf8")).split("\n").filter(Boolean)).toEqual(['{"a":1}', '{"a":2}']);

        if (process.platform !== "win32") {
            expect((await stat(file)).mode & 0o777).toBe(0o600);
            expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
        }
    });
});

describe("auditLog in the configuration", () => {
    const load = (argv: string[], env: NodeJS.ProcessEnv = {}) =>
        loadConfig({ argv, env, platform: "linux", homedir: "/h", readFile: () => undefined });

    it("takes an absolute path from the flag, the environment or the file", () => {
        expect(load(["--audit-log=/var/log/a.jsonl"]).auditLog).toBe("/var/log/a.jsonl");
        expect(load([], { CHROMIUM_DEVTOOLS_MCP_AUDIT_LOG: "/x/a.jsonl" }).auditLog).toBe("/x/a.jsonl");
        expect(load([]).auditLog).toBeUndefined();
    });

    it("refuses a relative path", () => {
        expect(() => load(["--audit-log=audit.jsonl"])).toThrow(/auditLog: must be an absolute path/);
    });
});
