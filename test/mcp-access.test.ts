import { describe, expect, it, vi } from "vitest";
import { DaemonAccess, SessionResetError } from "../src/mcp/index.js";
import { FakeLink } from "./helpers/fake-link.js";

describe("DaemonAccess requests", () => {
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

    it("forwards CDP calls and subscriptions", async () => {
        const link = new FakeLink((method) => (method === "cdp.send" ? { ok: true } : {}));
        const access = new DaemonAccess({ link: link.asLink() });

        await expect(
            access.send("t1", "Page.enable", { flag: true }, 500),
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
    it("delivers events to handlers registered on the link", async () => {
        const link = new FakeLink();
        const access = new DaemonAccess({ link: link.asLink() });
        const seen: unknown[] = [];

        access.on("tab.closed", (params) => seen.push(params));
        await vi.waitFor(() => expect(link.clients).toHaveLength(1));
        link.clients[0]?.emit("tab.closed", { targetId: "t1" });
        expect(seen).toEqual([{ targetId: "t1" }]);
    });

    it("keeps handlers across reconnects and attaches them to the new client", async () => {
        const link = new FakeLink(() => ({ tabs: [] }));
        const access = new DaemonAccess({ link: link.asLink() });
        const seen: unknown[] = [];

        access.on("tab.closed", (params) => seen.push(params));
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
