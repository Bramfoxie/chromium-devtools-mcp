import { describe, expect, it, vi } from "vitest";
import { DaemonAccess, SessionResetError } from "../src/mcp/index.js";
import { FakeLink } from "./helpers/fake-link.js";
import { confirmedAccess } from "../src/tools/confirmation.js";
import { ErrorCode, RpcError } from "../src/daemon/index.js";

describe("DaemonAccess requests", () => {
    it("cancels upload preparation when the caller aborts", async () => {
        const controller = new AbortController();
        let started: () => void = () => undefined;
        let finish: () => void = () => undefined;
        const entered = new Promise<void>((resolve) => { started = resolve; });
        const gate = new Promise<void>((resolve) => { finish = resolve; });
        const link = new FakeLink(async (method) => {
            if (method === "upload.prepare") {
                started();
                await gate;

                return { files: [{ path: "/private/copy", size: 4 }] };
            }

            return {};
        });
        const access = new DaemonAccess({ link: link.asLink() });
        const preparing = access.prepareUploads({ files: ["/allowed/file"], signal: controller.signal });

        await entered;
        controller.abort();
        await Promise.resolve();
        expect(link.clients[0]?.calls.map((call) => call.method)).toContain("upload.cancel");
        finish();
        await preparing;
    });

    it("passes confirmation to upload preparation", async () => {
        const link = new FakeLink((method) => method === "upload.prepare"
            ? { files: [{ path: "/private/copy", size: 4 }] } : {});
        const access = confirmedAccess(new DaemonAccess({ link: link.asLink() }));

        await access.prepareUploads({ files: ["/allowed/file"] });
        expect(link.clients[0]?.calls[0]?.params).toMatchObject({
            files: ["/allowed/file"], confirmed: true,
        });
    });

    it("explains how to replace an older daemon without upload preparation", async () => {
        const link = new FakeLink((method) => {
            if (method === "upload.prepare") throw new RpcError(ErrorCode.unknownMethod, "Unknown method.");

            return {};
        });
        const access = new DaemonAccess({ link: link.asLink() });

        await expect(access.prepareUploads({ files: ["/allowed/file"] })).rejects.toThrow("daemon stop");
    });

    it("sends typed requests and validates the results at the boundary", async () => {
        const link = new FakeLink((method) => {
            if (method === "tab.list") {
                return {
                    tabs: [{ targetId: "t1", url: "https://a.example/", title: "a", owned: true, created: true }],
                };
            }

            if (method === "tab.create") return { targetId: "t9" };

            if (method === "session.list") {
                return {
                    sessions: [{ sessionId: "s1", clientName: "c", isolated: false, tabs: 1, own: true }],
                };
            }

            return {};
        });
        const access = new DaemonAccess({ link: link.asLink() });

        await expect(access.createTab("https://a.example/")).resolves.toBe("t9");
        await expect(access.listTabs("owned")).resolves.toEqual([
            { targetId: "t1", url: "https://a.example/", title: "a", owned: true, created: true },
        ]);
        await expect(access.listSessions()).resolves.toEqual([
            { sessionId: "s1", clientName: "c", isolated: false, tabs: 1, own: true },
        ]);
    });

    it("rejects daemon results that do not match the schema", async () => {
        const link = new FakeLink(() => ({ tabs: [{ targetId: 5 }] }));
        const access = new DaemonAccess({ link: link.asLink() });

        await expect(access.listTabs("owned")).rejects.toThrow(/unexpected result/);
    });

    it("builds the cdp.send request from the fields of a command", async () => {
        const link = new FakeLink(() => ({ ok: true }));
        const access = new DaemonAccess({ link: link.asLink() });

        await access.send({
            targetId : "t1",
            method   : "Page.enable",
            params   : { flag: true },
            timeoutMs: 500,
            frameId  : "f1",
            confirmed: true,
        });
        await access.send({ targetId: "t1", method: "Page.enable" });

        const [full, minimal] = link.clients[0]?.calls ?? [];

        expect(full?.params).toEqual({
            targetId : "t1",
            method   : "Page.enable",
            params   : { flag: true },
            timeoutMs: 500,
            frameId  : "f1",
            confirmed: true,
        });
        expect(minimal?.params).toEqual({ targetId: "t1", method: "Page.enable" });
    });

    it("forwards CDP calls and subscriptions", async () => {
        const link = new FakeLink((method) => (method === "cdp.send" ? { ok: true } : {}));
        const access = new DaemonAccess({ link: link.asLink() });

        await expect(
            access.send({
                targetId : "t1",
                method   : "Page.enable",
                params   : { flag: true },
                timeoutMs: 500,
            }),
        ).resolves.toEqual({ ok: true });
        await access.subscribe("t1", "Page.loadEventFired");
        await access.unsubscribe("t1", "Page.loadEventFired");
        await access.claimTab("t1");
        await access.closeTab("t1");
        expect(link.clients[0]?.calls.map((call) => call.method)).toEqual([
            "cdp.send",
            "cdp.subscribe",
            "cdp.unsubscribe",
            "tab.claim",
            "tab.close",
        ]);
    });
});

describe("DaemonAccess events", () => {
    it("does not connect the link for local registrations", async () => {
        const link = new FakeLink();
        const access = new DaemonAccess({ link: link.asLink() });

        access.on("tab.closed", () => undefined);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(link.clients).toHaveLength(0);
    });

    it("delivers events to handlers registered on the link", async () => {
        const link = new FakeLink(() => ({ tabs: [] }));
        const access = new DaemonAccess({ link: link.asLink() });
        const seen: unknown[] = [];

        access.on("tab.closed", (params) => seen.push(params));
        await access.listTabs("owned");
        await vi.waitFor(() => expect(link.clients).toHaveLength(1));
        await vi.waitFor(() => {
            link.clients[0]?.emit("tab.closed", { targetId: "t1" });
            expect(seen).toEqual([{ targetId: "t1" }]);
        });
    });

    it("delivers events to a handler registered after the link is already attached", async () => {
        const link = new FakeLink(() => ({ tabs: [] }));
        const access = new DaemonAccess({ link: link.asLink() });
        const seen: unknown[] = [];

        await access.listTabs("owned");
        await vi.waitFor(() => expect(link.clients).toHaveLength(1));
        access.on("tab.closed", (params) => seen.push(params));
        await access.listTabs("owned");
        await vi.waitFor(() => {
            link.clients[0]?.emit("tab.closed", { targetId: "t1" });
            expect(seen).toEqual([{ targetId: "t1" }]);
        });
    });

    it("keeps handlers across reconnects and attaches them to the new client", async () => {
        const link = new FakeLink(() => ({ tabs: [] }));
        const access = new DaemonAccess({ link: link.asLink() });
        const seen: unknown[] = [];

        access.on("tab.closed", (params) => seen.push(params));
        await access.listTabs("owned");
        await vi.waitFor(() => expect(link.clients).toHaveLength(1));
        link.resetSession();
        await access.listTabs("owned");
        await vi.waitFor(() => expect(link.clients).toHaveLength(2));
        link.clients[1]?.emit("tab.closed", { targetId: "t2" });
        expect(seen).toEqual([{ targetId: "t2" }]);
    });

    it("stops delivering after the unsubscribe handle runs", async () => {
        const link = new FakeLink(() => ({ tabs: [] }));
        const access = new DaemonAccess({ link: link.asLink() });
        const seen: unknown[] = [];
        const off = access.on("tab.closed", (params) => seen.push(params));

        off();
        await access.listTabs("owned");
        link.resetSession();
        await access.listTabs("owned");
        await vi.waitFor(() => expect(link.clients).toHaveLength(2));
        link.clients[1]?.emit("tab.closed", { targetId: "t1" });
        expect(seen).toEqual([]);
    });

    it("delivers once when a reset lands before the first attach finishes", async () => {
        const link = new FakeLink(() => ({ tabs: [] }));

        link.reuseClient = true;

        const access = new DaemonAccess({ link: link.asLink() });
        const seen: unknown[] = [];

        access.forgetStaleState(() => undefined);
        access.on("tab.closed", (params) => seen.push(params));
        link.resetSession();
        await access.listTabs("owned");
        await vi.waitFor(() => expect(link.clients).toHaveLength(1));
        link.clients[0]?.emit("tab.closed", { targetId: "t1" });
        expect(seen).toEqual([{ targetId: "t1" }]);
    });
});

describe("session generations", () => {
    it("raises the generation and runs the reset hook when the session is lost", () => {
        const link = new FakeLink(() => ({ tabs: [] }));
        const access = new DaemonAccess({ link: link.asLink() });
        const resets: number[] = [];

        access.forgetStaleState(() => resets.push(access.sessionGeneration));
        link.resetSession();
        expect(resets).toEqual([1]);
    });

    it("rejects a request whose signal is already aborted", async () => {
        const link = new FakeLink(() => ({ tabs: [] }));
        const access = new DaemonAccess({ link: link.asLink() });
        const controller = new AbortController();

        controller.abort();
        await expect(access.send({
            targetId: "t1",
            method  : "Page.enable",
            signal  : controller.signal,
        })).rejects.toThrow(/abort|cancel/i);
    });

    it("rejects stale generations with the lost session error", async () => {
        const link = new FakeLink(() => ({ tabs: [] }));
        const access = new DaemonAccess({ link: link.asLink() });

        access.assertCurrent(0);
        link.resetSession();
        await access.listTabs("owned");
        access.assertCurrent(1);

        let failure: unknown;

        try {
            access.assertCurrent(0);
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(SessionResetError);
        expect((failure as Error).message).toContain("Open a new tab with new_tab.");
    });
});
