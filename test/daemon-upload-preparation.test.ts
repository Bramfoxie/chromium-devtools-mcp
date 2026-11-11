import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NO_SAFETY } from "../src/daemon/cdp-safety.js";
import { SessionRegistry } from "../src/daemon/sessions.js";
import { FakeBackend } from "./helpers/fake-backend.js";
import { CdpProtocolError, CdpTimeoutError } from "../src/cdp/index.js";

const ticket = "a".repeat(32);

describe("upload preparation", () => {
    it("removes the copy when the browser rejects the attachment", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-session-"));
        const allowed = path.join(root, "allowed");
        const file = path.join(allowed, "sample.txt");
        const backend = new FakeBackend();

        try {
            await mkdir(allowed);
            await writeFile(file, "original");
            const registry = new SessionRegistry<string>(backend, {
                allowFocus: false, downloadsRoot: path.join(root, "artifacts"),
            });
            const session = await registry.open("a", () => undefined, {
                isolated: false, clientName: "a", safety: { ...NO_SAFETY, uploadDirs: [allowed] },
            });
            const tab = await session.createTab("https://example.com/");

            await session.send({ targetId: tab, method: "Runtime.evaluate", params: { expression: "1" } });
            const browser = backend.sessions.get(tab);

            if (browser === undefined) throw new Error("No browser session.");

            browser.failure = new CdpProtocolError("DOM.setFileInputFiles", -32000, "Invalid node");
            const copies = await session.prepareUploads({ ticket, files: [file] });

            await expect(session.send({
                targetId: tab, method: "DOM.setFileInputFiles", params: { nodeId: 1, files: [copies[0]?.path] },
            })).rejects.toThrow();
            await expect(stat(copies[0]?.path ?? "")).rejects.toThrow();
            await session.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("enforces read only mode and confirmation before copying", async () => {
        const backend = new FakeBackend();
        const registry = new SessionRegistry<string>(backend, { allowFocus: false, downloadsRoot: "/unused" });
        const readOnly = await registry.open("read", () => undefined, {
            isolated: false, clientName: "read", safety: { ...NO_SAFETY, readOnly: true, uploadDirs: ["/allowed"] },
        });
        const confirm = await registry.open("confirm", () => undefined, {
            isolated  : false, clientName: "confirm",
            safety    : { ...NO_SAFETY, confirmDangerous: true, uploadDirs: ["/allowed"] },
        });

        await expect(readOnly.prepareUploads({ ticket, files: ["/allowed/file"] }))
            .rejects.toThrow("readOnly");
        await expect(confirm.prepareUploads({ ticket, files: ["/allowed/file"] }))
            .rejects.toThrow("confirmation");
        await readOnly.close();
        await confirm.close();
    });

    it("sends a private copy and retains it after the session closes", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-session-"));
        const allowed = path.join(root, "allowed");
        const file = path.join(allowed, "sample.txt");
        const backend = new FakeBackend();

        try {
            await mkdir(allowed);
            await writeFile(file, "original");
            const registry = new SessionRegistry<string>(backend, {
                allowFocus: false, downloadsRoot: path.join(root, "artifacts"),
            });
            const session = await registry.open("a", () => undefined, {
                isolated: false, clientName: "a", safety: { ...NO_SAFETY, uploadDirs: [allowed] },
            });
            const tab = await session.createTab("https://example.com/");
            const copies = await session.prepareUploads({ ticket, files: [file] });
            const copy = copies[0];

            expect(copy?.size).toBe(8);
            await writeFile(file, "replacement");
            await session.send({
                targetId: tab, method: "DOM.setFileInputFiles", params: { nodeId: 1, files: [copy?.path] },
            });
            await expect(session.send({
                targetId: tab, method: "DOM.setFileInputFiles", params: { nodeId: 1, files: [copy?.path] },
            })).rejects.toThrow("Prepare file attachments");
            await session.cancelUploads(ticket);
            await session.close();
            expect(await readFile(copy?.path ?? "", "utf8")).toBe("original");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("retains the copy if the attachment times out", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-session-"));
        const allowed = path.join(root, "allowed");
        const file = path.join(allowed, "sample.txt");
        const backend = new FakeBackend();

        try {
            await mkdir(allowed);
            await writeFile(file, "original");
            const registry = new SessionRegistry<string>(backend, {
                allowFocus: false, downloadsRoot: path.join(root, "artifacts"),
            });
            const session = await registry.open("a", () => undefined, {
                isolated: false, clientName: "a", safety: { ...NO_SAFETY, uploadDirs: [allowed] },
            });
            const tab = await session.createTab("https://example.com/");

            await session.send({ targetId: tab, method: "Runtime.evaluate", params: { expression: "1" } });
            const browser = backend.sessions.get(tab);

            if (browser === undefined) throw new Error("No browser session.");

            browser.failure = new CdpTimeoutError("DOM.setFileInputFiles", 100);
            const copies = await session.prepareUploads({ ticket, files: [file] });

            await expect(session.send({
                targetId: tab, method: "DOM.setFileInputFiles", params: { nodeId: 1, files: [copies[0]?.path] },
            })).rejects.toThrow();
            await session.close();
            expect(await readFile(copies[0]?.path ?? "", "utf8")).toBe("original");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("discards an unused copy when preparation is cancelled", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-session-"));
        const allowed = path.join(root, "allowed");
        const file = path.join(allowed, "sample.txt");

        try {
            await mkdir(allowed);
            await writeFile(file, "original");
            const registry = new SessionRegistry<string>(new FakeBackend(), {
                allowFocus: false, downloadsRoot: path.join(root, "artifacts"),
            });
            const session = await registry.open("a", () => undefined, {
                isolated: false, clientName: "a", safety: { ...NO_SAFETY, uploadDirs: [allowed] },
            });
            const copies = await session.prepareUploads({ ticket, files: [file] });

            await session.cancelUploads(ticket);
            await expect(stat(copies[0]?.path ?? "")).rejects.toThrow();
            await session.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("does not let another session attach a prepared copy", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-session-"));
        const allowed = path.join(root, "allowed");
        const file = path.join(allowed, "sample.txt");

        try {
            await mkdir(allowed);
            await writeFile(file, "original");
            const registry = new SessionRegistry<string>(new FakeBackend(), {
                allowFocus: false, downloadsRoot: path.join(root, "artifacts"),
            });
            const options = { isolated: false, clientName: "a", safety: { ...NO_SAFETY, uploadDirs: [allowed] } };
            const first = await registry.open("a", () => undefined, options);
            const second = await registry.open("b", () => undefined, options);
            const tab = await second.createTab("https://example.com/");
            const copies = await first.prepareUploads({ ticket, files: [file] });

            await expect(second.send({
                targetId: tab, method: "DOM.setFileInputFiles", params: { nodeId: 1, files: [copies[0]?.path] },
            })).rejects.toThrow("Prepare file attachments");
            await first.close();
            await second.close();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("discards an unused copy when the session closes", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-session-"));
        const allowed = path.join(root, "allowed");
        const file = path.join(allowed, "sample.txt");

        try {
            await mkdir(allowed);
            await writeFile(file, "original");
            const registry = new SessionRegistry<string>(new FakeBackend(), {
                allowFocus: false, downloadsRoot: path.join(root, "artifacts"),
            });
            const session = await registry.open("a", () => undefined, {
                isolated: false, clientName: "a", safety: { ...NO_SAFETY, uploadDirs: [allowed] },
            });
            const copies = await session.prepareUploads({ ticket, files: [file] });

            await session.close();
            await expect(stat(copies[0]?.path ?? "")).rejects.toThrow();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("stops preparation cancelled while a path is being checked", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-session-"));
        const allowed = path.join(root, "allowed");
        const file = path.join(allowed, "sample.txt");
        let unblock: () => void = () => undefined;
        let started: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => { unblock = resolve; });
        const entered = new Promise<void>((resolve) => { started = resolve; });

        try {
            await mkdir(allowed);
            await writeFile(file, "original");
            const registry = new SessionRegistry<string>(new FakeBackend(), {
                allowFocus       : false, downloadsRoot    : path.join(root, "artifacts"),
                resolveUploadPath: async (value) => {
                    if (value === file) {
                        started();
                        await gate;
                    }

                    return value;
                },
            });
            const session = await registry.open("a", () => undefined, {
                isolated: false, clientName: "a", safety: { ...NO_SAFETY, uploadDirs: [allowed] },
            });
            const preparing = session.prepareUploads({ ticket, files: [file] });
            const settled = expect(preparing).rejects.toThrow("safety.uploadDirs");

            await entered;
            await session.cancelUploads(ticket);
            unblock();
            await settled;
            await session.close();
        } finally {
            unblock();
            await rm(root, { recursive: true, force: true });
        }
    });

    it("does not attach a copy cancelled while the browser session is connecting", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "cdm-upload-session-"));
        const allowed = path.join(root, "allowed");
        const file = path.join(allowed, "sample.txt");
        const backend = new FakeBackend();
        let unblock: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => { unblock = resolve; });

        try {
            await mkdir(allowed);
            await writeFile(file, "original");
            const registry = new SessionRegistry<string>(backend, {
                allowFocus: false, downloadsRoot: path.join(root, "artifacts"),
            });
            const session = await registry.open("a", () => undefined, {
                isolated: false, clientName: "a", safety: { ...NO_SAFETY, uploadDirs: [allowed] },
            });
            const tab = await session.createTab("https://example.com/");
            const copies = await session.prepareUploads({ ticket, files: [file] });

            backend.gates.attach = gate;
            const sending = session.send({
                targetId: tab, method: "DOM.setFileInputFiles", params: { nodeId: 1, files: [copies[0]?.path] },
            });
            const settled = expect(sending).rejects.toThrow("Prepare file attachments");

            await Promise.resolve();
            await Promise.resolve();
            await session.cancelUploads(ticket);
            unblock();
            await settled;
            expect(backend.sessions.get(tab)?.sent.some((call) => call.method === "DOM.setFileInputFiles"))
                .not.toBe(true);
            await session.close();
        } finally {
            unblock();
            await rm(root, { recursive: true, force: true });
        }
    });
});
