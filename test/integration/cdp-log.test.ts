import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv } from "./browser-env.js";

describe.skipIf(!chromeAvailable())("CDP traffic log in a real browser", () => {
    it("records metadata without the contents of browser messages", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "cdm-cdp-log-"));
        const file = path.join(dir, "traffic.jsonl");
        const env = await startEnv(undefined, false, undefined, undefined, false, file);

        try {
            env.fixture.pages.set("/cdp-log", html("<p>PAGE-SECRET</p>"));
            const tab = await env.open("/cdp-log");

            await env.ok("js_evaluate", { tab, expression: "'EXPRESSION-SECRET'" });
            const contents = await readFile(file, "utf8");

            expect(contents).toContain("Runtime.evaluate");
            expect(contents).not.toContain("EXPRESSION-SECRET");
            expect(contents).not.toContain("PAGE-SECRET");
            const entries = contents.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

            expect(entries.length).toBeGreaterThan(0);

            for (const entry of entries) {
                expect(Object.keys(entry).every((key) => ["direction", "method", "id", "bytes"].includes(key))).toBe(true);
            }
        } finally {
            await env.stop();
            await rm(dir, { recursive: true, force: true });
        }
    });
});
