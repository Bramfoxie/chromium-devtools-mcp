import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CdpClosedError,
    CdpProtocolError,
    CdpSessionDetachedError,
    CdpTimeoutError,
} from "../src/cdp/index.js";
import { ErrorCode, RpcError, SessionRegistry } from "../src/daemon/index.js";
import { FakeBackend } from "./helpers/fake-backend.js";

interface Emitted {
    event : string;
    params: unknown;
}

type ClientSessionLike = Awaited<ReturnType<SessionRegistry<string>["open"]>>;

function setup(allowFocus = false) {
    const backend = new FakeBackend();
    const registry = new SessionRegistry<string>(backend, { allowFocus });
    const emitted: Record<string, Emitted[]> = {};
    const open = async (key: string, isolated = false, clientName = `client-${key}`) => {
        emitted[key] = [];

        const emit = (event: string, params?: unknown) => emitted[key]?.push({ event, params });

        return registry.open(key, emit, { isolated, clientName });
    };

    return { backend, registry, emitted, open };
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
    const error = await promise.then(
        () => undefined,
        (failure: unknown) => failure,
    );

    return error instanceof RpcError ? error.code : error === undefined ? undefined : "other";
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("opening sessions", () => {
    it("uses the default context unless an isolated one is requested", async () => {
        const { backend, open } = setup();
        const shared = await open("a");
        const isolated = await open("b", true);

        expect(shared.isolated).toBe(false);
        expect(shared.contextId).toBeUndefined();
        expect(isolated.isolated).toBe(true);
        expect(backend.log).toEqual(["createContext ctx1"]);
    });

    it("allows one session per connection", async () => {
        const { open } = setup();

        await open("a");
        expect(await code(open("a"))).toBe(ErrorCode.badRequest);
    });

    it("rejects a concurrent second open on the same connection", async () => {
        const { backend, open } = setup();
        let release: () => void = () => undefined;

        backend.gates.createContext = new Promise<void>((resolve) => (release = resolve));
        const first = open("a", true);

        expect(await code(open("a", true))).toBe(ErrorCode.badRequest);
        release();
        await first;
    });

    it("does not leak a context when the connection closes while it is being created", async () => {
        const { backend, registry, open } = setup();
        let release: () => void = () => undefined;

        backend.gates.createContext = new Promise<void>((resolve) => (release = resolve));
        const opening = open("a", true);

        await registry.close("a");
        release();
        expect(await code(opening)).toBe(ErrorCode.sessionClosed);
        expect(backend.contexts.size).toBe(0);
        expect(registry.get("a")).toBeUndefined();
    });

    it("lets the connection open again after a failed context creation", async () => {
        const { backend, open } = setup();

        backend.failures.createContext = [new Error("denied")];
        expect(await code(open("a", true))).toBe("other");
        await expect(open("a", true)).resolves.toBeDefined();
    });
});

describe("tab ownership", () => {
    it("creates tabs in the context of the session", async () => {
        const { backend, open } = setup();
        const shared = await open("a");
        const isolated = await open("b", true);

        await shared.createTab("https://a.example/");
        await isolated.createTab("https://b.example/");
        expect(backend.log).toContain("createTarget tab2 default https://a.example/");
        expect(backend.log).toContain("createTarget tab3 ctx1 https://b.example/");
    });

    it("separates a missing tab from a tab of another session", async () => {
        const { open } = setup();
        const a = await open("a");
        const b = await open("b");
        const tab = await a.createTab("about:blank");

        expect(await code(b.send(tab, "Page.enable", undefined))).toBe(ErrorCode.notOwned);
        expect(await code(b.closeTab(tab))).toBe(ErrorCode.notOwned);
        expect(await code(b.subscribe(tab, "Page.loadEventFired"))).toBe(ErrorCode.notOwned);
        expect(() => b.unsubscribe(tab, "Page.loadEventFired")).toThrow(RpcError);
        expect(await code(b.send("nope", "Page.enable", undefined))).toBe(ErrorCode.notFound);
    });

    it("lists only the tabs of the session as owned", async () => {
        const { open } = setup();
        const a = await open("a");
        const b = await open("b");
        const first = await a.createTab("https://a.example/");

        await b.createTab("https://b.example/");
        const owned = await a.listTabs("owned");

        expect(owned).toEqual([
            {
                targetId: first,
                url     : "https://a.example/",
                title   : "title of https://a.example/",
                owned   : true,
                created : true,
            },
        ]);
    });

    it("shows unowned tabs of its own context as available", async () => {
        const { backend, open } = setup();
        const shared = await open("a");
        const isolated = await open("b", true);
        const userTab = backend.seedTab("https://user.example/");
        const incognito = backend.seedTab("https://private.example/", "someone-elses-context");
        const own = await isolated.createTab("https://b.example/");
        const sharedAvailable = (await shared.listTabs("available")).map((tab) => tab.targetId);

        expect(sharedAvailable).toEqual([userTab]);
        expect(sharedAvailable).not.toContain(incognito);
        expect(sharedAvailable).not.toContain(own);
        expect(await isolated.listTabs("available")).toEqual([]);
    });

    it("claims a tab of the user and leaves it open when the session ends", async () => {
        const { backend, registry, open } = setup();
        const a = await open("a");
        const userTab = backend.seedTab("https://user.example/");

        await a.claimTab(userTab);
        expect((await a.listTabs("owned"))[0]).toMatchObject({ targetId: userTab, created: false });
        expect(await a.listTabs("available")).toEqual([]);
        await registry.close("a");
        expect(backend.log).not.toContain(`closeTarget ${userTab}`);
        expect(backend.targets.has(userTab)).toBe(true);
    });

    it("refuses a tab that another session already uses", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const b = await open("b");
        const userTab = backend.seedTab("https://user.example/");

        await a.claimTab(userTab);
        expect(await code(b.claimTab(userTab))).toBe(ErrorCode.alreadyClaimed);
        const created = await a.createTab("about:blank");

        expect(await code(b.claimTab(created))).toBe(ErrorCode.alreadyClaimed);
    });

    it("lets exactly one of two concurrent claims win", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const b = await open("b");
        const userTab = backend.seedTab("https://user.example/");
        const results = await Promise.all([code(a.claimTab(userTab)), code(b.claimTab(userTab))]);

        expect(results.filter((result) => result === undefined)).toHaveLength(1);
        expect(results.filter((result) => result === ErrorCode.alreadyClaimed)).toHaveLength(1);
    });

    it("tells a same-session racing claim about itself, not about another session", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const userTab = backend.seedTab("https://user.example/");
        let release: () => void = () => undefined;

        backend.gates.listTargets = new Promise<void>((resolve) => (release = resolve));

        const first = a.claimTab(userTab).then(
            () => undefined,
            (failure: unknown) => failure,
        );
        const second = a.claimTab(userTab).then(
            () => undefined,
            (failure: unknown) => failure,
        );

        await new Promise((resolve) => setImmediate(resolve));
        release();
        const failures = (await Promise.all([first, second])).filter(
            (result): result is RpcError => result instanceof RpcError,
        );

        expect(failures).toHaveLength(1);
        expect(failures[0]?.code).toBe(ErrorCode.alreadyClaimed);
        expect((failures[0] as Error).message).toContain("by this session");
    });

    it("does not claim tabs of other contexts or tabs that do not exist", async () => {
        const { backend, open } = setup();
        const shared = await open("a");
        const isolated = await open("b", true);
        const foreign = backend.seedTab("https://x.example/", "other-context");
        const userTab = backend.seedTab("https://user.example/");

        expect(await code(shared.claimTab(foreign))).toBe(ErrorCode.notFound);
        expect(await code(isolated.claimTab(userTab))).toBe(ErrorCode.notFound);
        expect(await code(shared.claimTab("missing"))).toBe(ErrorCode.notFound);
    });

    it("does not keep ownership of a tab claimed while the session closes", async () => {
        const { backend, registry, open } = setup();
        const a = await open("a");
        const userTab = backend.seedTab("https://user.example/");
        let release: () => void = () => undefined;

        backend.gates.listTargets = new Promise<void>((resolve) => (release = resolve));
        const claiming = a.claimTab(userTab);

        await registry.close("a");
        release();
        expect(await code(claiming)).toBe(ErrorCode.sessionClosed);
        expect(registry.ownerOf(userTab)).toBeUndefined();
        backend.gates.listTargets = undefined;
        const b = await open("b");

        await expect(b.claimTab(userTab)).resolves.toBeUndefined();
    });

    it("treats claiming an owned tab as a no-op", async () => {
        const { open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        await expect(a.claimTab(tab)).resolves.toBeUndefined();
    });

    it("refuses to close a tab of the user that was only claimed", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const userTab = backend.seedTab("https://user.example/");

        await a.claimTab(userTab);
        expect(await code(a.closeTab(userTab))).toBe(ErrorCode.notCreated);
        expect(backend.targets.has(userTab)).toBe(true);
    });

    it("does not tell the client about a tab it closed itself", async () => {
        const { emitted, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        await a.closeTab(tab);
        expect(emitted.a).toEqual([]);
    });

    it("answers a second concurrent close of the same tab with not_found", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");
        let release: () => void = () => undefined;

        backend.gates.closeTarget = new Promise<void>((resolve) => (release = resolve));
        const first = a.closeTab(tab);

        expect(await code(a.closeTab(tab))).toBe(ErrorCode.notFound);
        expect(await code(a.send(tab, "Page.enable", undefined))).toBe(ErrorCode.notFound);
        expect(await a.listTabs("owned")).toEqual([]);
        release();
        await first;
    });

    it("keeps a tab usable when closing it fails", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        backend.failures.closeTarget = [new Error("nope")];
        expect(await code(a.closeTab(tab))).toBe("other");
        await expect(a.send(tab, "Page.enable", undefined)).resolves.toBeDefined();
        await expect(a.closeTab(tab)).resolves.toBeUndefined();
    });

    it("does not own a tab that was destroyed while it was being created", async () => {
        const { backend, registry, open } = setup();
        const a = await open("a");

        backend.afterCreate = (id) => backend.destroyTarget(id);
        expect(await code(a.createTab("about:blank"))).toBe(ErrorCode.notFound);
        expect(registry.ownerOf("tab1")).toBeUndefined();
        expect(await a.listTabs("owned")).toEqual([]);
    });

    it("does not own a tab that was destroyed while it was being claimed", async () => {
        const { backend, registry, open } = setup();
        const a = await open("a");
        const userTab = backend.seedTab("https://user.example/");
        let release: () => void = () => undefined;

        backend.gates.listTargets = new Promise<void>((resolve) => (release = resolve));
        const claiming = a.claimTab(userTab);

        backend.destroyTarget(userTab);
        release();
        expect(await code(claiming)).toBe(ErrorCode.notFound);
        expect(registry.ownerOf(userTab)).toBeUndefined();
    });

    it("closes a tab and frees its ownership", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        await a.closeTab(tab);
        expect(backend.targets.has(tab)).toBe(false);
        expect(await code(a.closeTab(tab))).toBe(ErrorCode.notFound);
    });

    it("forgets a tab the user closed and tells the client", async () => {
        const { backend, emitted, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        await a.send(tab, "Page.enable", undefined);
        backend.destroyTarget(tab);
        expect(emitted.a).toEqual([{ event: "tab.closed", params: { targetId: tab } }]);
        expect(await a.listTabs("owned")).toEqual([]);
        expect(await code(a.send(tab, "Page.enable", undefined))).toBe(ErrorCode.notFound);
        await vi.waitFor(() => expect(backend.sessions.get(tab)?.detached).toBe(true));
    });

    it("ignores the destruction of a tab nobody owns", async () => {
        const { backend, emitted, open } = setup();

        await open("a");
        backend.destroyTarget("unknown");
        expect(emitted.a).toEqual([]);
    });
});

describe("closing a session", () => {
    it("closes the tabs it created in the shared context, detaches and frees ownership", async () => {
        const { backend, registry, open } = setup();
        const a = await open("a");
        const b = await open("b");
        const tab = await a.createTab("about:blank");

        await a.send(tab, "Page.enable", undefined);
        await registry.close("a");
        expect(backend.targets.has(tab)).toBe(false);
        expect(backend.sessions.get(tab)?.detached).toBe(true);
        expect(registry.ownerOf(tab)).toBeUndefined();
        expect(await code(a.createTab("about:blank"))).toBe(ErrorCode.sessionClosed);
        expect(await code(a.listTabs("owned"))).toBe(ErrorCode.sessionClosed);
        expect(await b.listTabs("owned")).toEqual([]);
    });

    it("keeps the tabs of a closing session unavailable until they are really closed", async () => {
        const { backend, registry, open } = setup();
        const a = await open("a");
        const b = await open("b");
        const tab = await a.createTab("about:blank");
        let release: () => void = () => undefined;

        backend.gates.closeTarget = new Promise<void>((resolve) => (release = resolve));
        const closing = registry.close("a");

        await Promise.resolve();
        expect(await code(b.claimTab(tab))).toBe(ErrorCode.alreadyClaimed);
        expect((await b.listTabs("available")).map((item) => item.targetId)).not.toContain(tab);
        release();
        await closing;
        expect(registry.ownerOf(tab)).toBeUndefined();
        expect(backend.targets.has(tab)).toBe(false);
    });

    it("releases claimed tabs of the user immediately", async () => {
        const { backend, registry, open } = setup();
        const a = await open("a");
        const b = await open("b");
        const userTab = backend.seedTab("https://user.example/");

        await a.claimTab(userTab);
        let release: () => void = () => undefined;

        backend.gates.closeTarget = new Promise<void>((resolve) => (release = resolve));
        const created = await a.createTab("about:blank");
        const closing = registry.close("a");

        await Promise.resolve();
        await expect(b.claimTab(userTab)).resolves.toBeUndefined();
        expect(await code(b.claimTab(created))).toBe(ErrorCode.alreadyClaimed);
        release();
        await closing;
    });

    it("does not wait forever for an attach that never finishes", async () => {
        vi.useFakeTimers();

        try {
            const { backend, registry, open } = setup();
            const a = await open("a", true);
            const tab = await a.createTab("about:blank");

            backend.gates.attach = new Promise<void>(() => undefined);
            void a.send(tab, "Page.enable", undefined).catch(() => undefined);
            await vi.advanceTimersByTimeAsync(0);
            const closing = registry.close("a");

            await vi.advanceTimersByTimeAsync(2500);
            await closing;
            expect(backend.contexts.size).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("refuses new sessions after closeAll", async () => {
        const { registry, open } = setup();

        await registry.closeAll();
        expect(await code(open("late"))).toBe(ErrorCode.sessionClosed);
    });

    it("does not let a stale open of a reused key steal the marker of a newer one", async () => {
        const { backend, registry, open } = setup();
        let releaseFirst: () => void = () => undefined;

        backend.gates.createContext = new Promise<void>((resolve) => (releaseFirst = resolve));
        const first = open("a", true);

        await registry.close("a");
        backend.gates.createContext = undefined;
        const second = await open("a", true);

        releaseFirst();
        expect(await code(first)).toBe(ErrorCode.sessionClosed);
        expect(registry.get("a")).toBe(second);
        expect(second.closed).toBe(false);
    });

    it("disposes an isolated context instead of closing tabs one by one", async () => {
        const { backend, registry, open } = setup();
        const a = await open("a", true);

        await a.createTab("https://a.example/");
        await a.createTab("https://b.example/");
        await registry.close("a");
        expect(backend.log.filter((line) => line.startsWith("closeTarget"))).toEqual([]);
        expect(backend.log).toContain("disposeContext ctx1");
        expect(backend.contexts.size).toBe(0);
    });

    it("is idempotent", async () => {
        const { backend, registry, open } = setup();
        const a = await open("a", true);

        await registry.close("a");
        await a.close();
        await registry.close("a");
        expect(backend.log.filter((line) => line.startsWith("disposeContext"))).toHaveLength(1);
    });

    it("keeps cleaning up when one step fails and logs it", async () => {
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const { backend, registry, open } = setup();
        const a = await open("a");
        const first = await a.createTab("about:blank");
        const second = await a.createTab("about:blank");

        backend.failures.closeTarget = [new Error("secret-detail")];
        await registry.close("a");
        expect(backend.log.filter((line) => line.startsWith("closeTarget"))).toEqual([
            `closeTarget ${second}`,
        ]);
        expect(first).not.toBe(second);
        expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
            "could not close a tab",
        );
    });

    it("closes a tab that finishes opening after the session ended", async () => {
        const { backend, registry, open } = setup();
        const a = await open("a");
        let release: () => void = () => undefined;

        backend.gates.createTarget = new Promise<void>((resolve) => (release = resolve));
        const creating = a.createTab("about:blank");

        await registry.close("a");
        release();
        expect(await code(creating)).toBe(ErrorCode.sessionClosed);
        expect(backend.targets.size).toBe(0);
    });

    it("closes every session and stops listening to the browser on closeAll", async () => {
        const { backend, registry, open } = setup();

        await open("a", true);
        await open("b", true);
        expect(backend.destroyListenerCount).toBe(1);
        await registry.closeAll();
        expect(backend.contexts.size).toBe(0);
        expect(backend.destroyListenerCount).toBe(0);
    });
});

describe("sending commands", () => {
    it("attaches lazily once and passes the parameters and timeout", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        expect(backend.log.some((line) => line.startsWith("attach"))).toBe(false);
        await a.send(tab, "Page.navigate", { url: "https://x.example/" }, 1234);
        await a.send(tab, "Page.enable", undefined);
        expect(backend.log.filter((line) => line.startsWith("attach"))).toEqual([`attach ${tab}`]);
        expect(backend.sessions.get(tab)?.sent).toEqual([
            { method: "Page.navigate", params: { url: "https://x.example/" }, timeoutMs: 1234 },
            { method: "Page.enable", params: undefined, timeoutMs: undefined },
        ]);
    });

    it("sends the normalized URL of Page.navigate to the browser", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        await a.send(tab, "Page.navigate", { url: " HTTPS://X.example " });
        expect(backend.sessions.get(tab)?.sent).toEqual([
            { method: "Page.navigate", params: { url: "https://x.example/" }, timeoutMs: undefined },
        ]);
    });

    it("shares one attach between concurrent commands", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        await Promise.all([
            a.send(tab, "Page.enable", undefined),
            a.send(tab, "Runtime.enable", undefined),
        ]);
        expect(backend.log.filter((line) => line.startsWith("attach"))).toHaveLength(1);
    });

    it("retries the attach after a failure", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        backend.failures.attach = [new Error("detached")];
        expect(await code(a.send(tab, "Page.enable", undefined))).toBe("other");
        await expect(a.send(tab, "Page.enable", undefined)).resolves.toBeDefined();
    });

    it.each([
        "Target.createTarget",
        "Target.activateTarget",
        "Browser.close",
        "Security.setIgnoreCertificateErrors",
        "SystemInfo.getInfo",
        "Storage.clearDataForOrigin",
        "target.createTarget",
        "NoDot",
    ])("refuses the command %s", async (method) => {
        const { open } = setup(true);
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        expect(await code(a.send(tab, method, undefined))).toBe(ErrorCode.forbiddenMethod);
    });

    it.each([
        "Page.reload",
        "Runtime.evaluate",
        "DOM.getDocument",
        "Network.enable",
        "Input.dispatchMouseEvent",
        "Emulation.setDeviceMetricsOverride",
    ])("allows the tab command %s", async (method) => {
        const { open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        await expect(a.send(tab, method, undefined)).resolves.toBeDefined();
    });

    it("refuses to bring the window to the front unless allowFocus is on", async () => {
        const off = setup(false);
        const a = await off.open("a");
        const tab = await a.createTab("about:blank");

        expect(await code(a.send(tab, "Page.bringToFront", undefined))).toBe(ErrorCode.forbiddenMethod);
        const on = setup(true);
        const b = await on.open("b");
        const allowed = await b.createTab("about:blank");

        await expect(b.send(allowed, "Page.bringToFront", undefined)).resolves.toBeDefined();
    });
});

describe("races with closing", () => {
    it("does not send a command that was waiting for an attach when the session closes", async () => {
        const { backend, registry, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");
        let release: () => void = () => undefined;

        backend.gates.attach = new Promise<void>((resolve) => (release = resolve));
        const sending = a.send(tab, "Page.navigate", { url: "https://x.example/" });

        await Promise.resolve();
        const closing = registry.close("a");

        release();
        expect(await code(sending)).toBe(ErrorCode.sessionClosed);
        await closing;
        expect(backend.sessions.get(tab)?.sent ?? []).toEqual([]);
    });

    it("does not report success for a subscription whose tab disappeared", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");
        let release: () => void = () => undefined;

        backend.gates.attach = new Promise<void>((resolve) => (release = resolve));
        const subscribing = a.subscribe(tab, "Page.loadEventFired");

        await Promise.resolve();
        backend.destroyTarget(tab);
        release();
        expect(await code(subscribing)).toBe(ErrorCode.notFound);
    });

    it("registers one listener for two concurrent subscriptions to an event", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        await Promise.all([a.subscribe(tab, "Page.loadEventFired"), a.subscribe(tab, "Page.loadEventFired")]);
        expect(backend.sessions.get(tab)?.listenerCount("Page.loadEventFired")).toBe(1);
    });

    it.each([
        ["send", (a: ClientSessionLike, tab: string) => a.send(tab, "Page.enable", undefined)],
        ["subscribe", (a: ClientSessionLike, tab: string) => a.subscribe(tab, "Page.loadEventFired")],
        ["closeTab", (a: ClientSessionLike, tab: string) => a.closeTab(tab)],
        ["claimTab", (a: ClientSessionLike, tab: string) => a.claimTab(tab)],
        ["listTabs", (a: ClientSessionLike) => a.listTabs("owned")],
    ])("%s on a closed session answers session_closed", async (_name, run) => {
        const { registry, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        await registry.close("a");
        expect(await code(run(a, tab))).toBe(ErrorCode.sessionClosed);
    });
});

describe("CDP failures", () => {
    it.each([
        [new CdpProtocolError("Page.navigate", -32000, "bad url"), ErrorCode.cdpError],
        [new CdpSessionDetachedError("Page.navigate", "s1"), ErrorCode.cdpError],
        [new CdpTimeoutError("Page.navigate", 100), ErrorCode.cdpTimeout],
        [new CdpClosedError("socket closed"), ErrorCode.browserClosed],
    ])("maps %s to a typed daemon error", async (failure, expected) => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        await a.send(tab, "Page.enable", undefined);
        const session = backend.sessions.get(tab);

        if (session) session.failure = failure;

        const error = await a.send(tab, "Page.reload", undefined).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(RpcError);
        expect((error as RpcError).code).toBe(expected);
        expect((error as RpcError).message).toContain(failure.message);
    });

    it("maps CDP errors of the attach step too", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        backend.failures.attach = [new CdpClosedError("gone")];
        expect(await code(a.send(tab, "Page.enable", undefined))).toBe(ErrorCode.browserClosed);
    });
});

describe("subscriptions", () => {
    it("forwards events of the subscribed tab to the client", async () => {
        const { backend, emitted, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        await a.subscribe(tab, "Page.loadEventFired");
        backend.sessions.get(tab)?.emit("Page.loadEventFired", { timestamp: 1 });
        backend.sessions.get(tab)?.emit("Page.other", {});
        expect(emitted.a).toEqual([
            {
                event : "cdp.event",
                params: { targetId: tab, event: "Page.loadEventFired", params: { timestamp: 1 } },
            },
        ]);
    });

    it("refuses to subscribe to events outside the allowed domains", async () => {
        const { backend, open } = setup();
        const tab = backend.seedTab("https://a.example/");
        const session = await open("a");

        await session.claimTab(tab);
        expect(await code(session.subscribe(tab, "Target.targetCreated"))).toBe(
            ErrorCode.forbiddenMethod,
        );
    });

    it("does not subscribe twice and stops after unsubscribe", async () => {
        const { backend, emitted, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        await a.subscribe(tab, "Page.loadEventFired");
        await a.subscribe(tab, "Page.loadEventFired");
        expect(backend.sessions.get(tab)?.listenerCount("Page.loadEventFired")).toBe(1);
        a.unsubscribe(tab, "Page.loadEventFired");
        expect(backend.sessions.get(tab)?.listenerCount("Page.loadEventFired")).toBe(1);
        a.unsubscribe(tab, "Page.loadEventFired");
        expect(backend.sessions.get(tab)?.listenerCount("Page.loadEventFired")).toBe(0);
        backend.sessions.get(tab)?.emit("Page.loadEventFired", {});
        expect(emitted.a).toEqual([]);
    });

    it("keeps a shared event alive until every subscriber leaves", async () => {
        const { backend, emitted, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        await a.subscribe(tab, "Page.frameNavigated");
        await a.subscribe(tab, "Page.frameNavigated");
        a.unsubscribe(tab, "Page.frameNavigated");
        expect(backend.sessions.get(tab)?.listenerCount("Page.frameNavigated")).toBe(1);
        backend.sessions.get(tab)?.emit("Page.frameNavigated", { frame: { id: "main" } });
        expect(emitted.a).toHaveLength(1);
        a.unsubscribe(tab, "Page.frameNavigated");
        expect(backend.sessions.get(tab)?.listenerCount("Page.frameNavigated")).toBe(0);
        backend.sessions.get(tab)?.emit("Page.frameNavigated", { frame: { id: "main" } });
        expect(emitted.a).toHaveLength(1);
    });

    it("drops frame subscriptions when the child session detaches", async () => {
        const { backend, emitted, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");

        await a.send(tab, "Page.enable", undefined);
        const session = backend.sessions.get(tab);

        if (session) {
            session.reply = (method) =>
                method === "Page.getFrameTree"
                    ? { frameTree: { frame: { id: "main", url: "https://a.example/" } } }
                    : { echoed: method };
        }

        await a.listFrames(tab);
        backend.childHandles[0]?.addChild("main");
        await a.listFrames(tab);
        await a.subscribe(tab, "Page.frameNavigated", "main");
        backend.childHandles[0]?.removeChild("main");
        backend.childHandles[0]?.addChild("main");
        await a.listFrames(tab);
        await a.subscribe(tab, "Page.frameNavigated", "main");
        const child = backend.childHandles[0]?.childSession("main");

        child?.emit("Page.frameNavigated", { frame: { id: "main" } });
        expect(emitted.a).toHaveLength(1);
    });

    it("drops subscriptions with the tab and with the session", async () => {
        const { backend, registry, open } = setup();
        const a = await open("a");
        const first = await a.createTab("about:blank");
        const second = await a.createTab("about:blank");

        await a.subscribe(first, "Page.loadEventFired");
        await a.subscribe(second, "Page.loadEventFired");
        await a.closeTab(first);
        expect(backend.sessions.get(first)?.listenerCount("Page.loadEventFired")).toBe(0);
        await registry.close("a");
        expect(backend.sessions.get(second)?.listenerCount("Page.loadEventFired")).toBe(0);
    });

    it("does not register a subscription that finishes after the tab is gone", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("about:blank");
        const subscribing = a.subscribe(tab, "Page.loadEventFired");

        backend.destroyTarget(tab);
        expect(await code(subscribing)).toBe(ErrorCode.notFound);
        expect(backend.sessions.get(tab)?.listenerCount("Page.loadEventFired") ?? 0).toBe(0);
    });
});

describe("listing sessions", () => {
    it("reports every session with its own flag on the caller", async () => {
        const { registry, open } = setup();
        const a = await open("a", false, "alice");
        const b = await open("b", true, "bob");

        await a.createTab("https://a.example/");
        await a.createTab("https://a2.example/");
        await b.createTab("https://b.example/");

        const seen = registry.listSessions("a");

        expect(seen).toHaveLength(2);
        expect(seen.find((session) => session.clientName === "alice")).toMatchObject({
            clientName: "alice",
            isolated  : false,
            tabs      : 2,
            own       : true,
        });
        expect(seen.find((session) => session.clientName === "bob")).toMatchObject({
            clientName: "bob",
            isolated  : true,
            tabs      : 1,
            own       : false,
        });
    });

    it("gives every session a unique id and reveals nothing about other tabs", async () => {
        const { registry, open } = setup();

        await open("a", false, "alice");
        await open("b", false, "bob");
        const seen = registry.listSessions("a");
        const ids = seen.map((session) => session.sessionId);

        expect(new Set(ids).size).toBe(2);
        expect(JSON.stringify(seen)).not.toContain("targetId");
        expect(seen).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    sessionId : expect.any(String),
                    clientName: "bob",
                    isolated  : false,
                    tabs      : 0,
                    own       : false,
                }),
            ]),
        );
        expect(Object.keys(seen[0] ?? {}).sort()).toEqual(
            ["clientName", "isolated", "own", "sessionId", "tabs"].sort(),
        );
    });

    it("drops closed sessions from the list", async () => {
        const { registry, open } = setup();

        await open("a", false, "alice");
        await open("b", false, "bob");
        await registry.close("b");
        const seen = registry.listSessions("a");

        expect(seen.map((session) => session.clientName)).toEqual(["alice"]);
    });

    it("marks no session as own for an unknown caller", async () => {
        const { registry, open } = setup();

        await open("a", false, "alice");
        const seen = registry.listSessions("gone");

        expect(seen).toEqual([
            expect.objectContaining({ clientName: "alice", own: false }),
        ]);
    });

    it("counts only open tabs of a session", async () => {
        const { registry, open } = setup();
        const a = await open("a", false, "alice");
        const first = await a.createTab("https://a.example/");

        await a.createTab("https://a2.example/");
        await a.closeTab(first);
        const seen = registry.listSessions("a");

        expect(seen).toEqual([expect.objectContaining({ tabs: 1 })]);
    });
});

describe("frame targets", () => {
    const TREE = {
        frameTree: {
            frame      : { id: "main", url: "https://a.example/", name: "" },
            childFrames: [
                {
                    frame: {
                        id      : "same",
                        parentId: "main",
                        url     : "https://a.example/inner",
                        name    : "inner",
                    },
                },
            ],
        },
    };
    const CROSS = { url: "https://b.example/", name: "pay" };

    function mainTree(): (method: string) => unknown {
        return (method) => (method === "Page.getFrameTree" ? TREE : { echoed: method });
    }

    it("lists the same site frames of the main tree as shared", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("https://a.example/");

        await a.send(tab, "Page.enable", undefined);
        const session = backend.sessions.get(tab);

        if (session) session.reply = mainTree();

        expect(await a.listFrames(tab)).toEqual([
            { frameId: "main", parentFrameId: undefined, url: "https://a.example/", name: "", isolated: false, truncated: false },
            { frameId: "same", parentFrameId: "main", url: "https://a.example/inner", name: "inner", isolated: false, truncated: false },
        ]);
        expect(backend.childHandles.map((handle) => handle.targetId)).toEqual([tab]);
    });

    it("marks a frame isolated once its child session is matched", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("https://a.example/");

        await a.send(tab, "Page.enable", undefined);
        const session = backend.sessions.get(tab);

        if (session) session.reply = mainTree();

        await a.listFrames(tab);
        backend.childHandles[0]?.addChild("cross", true, CROSS);
        const frames = await a.listFrames(tab);

        expect(frames.find((frame) => frame.frameId === "cross")).toMatchObject({ isolated: true });
        expect(frames.find((frame) => frame.frameId === "same")).toMatchObject({ isolated: false });
    });

    it("routes cdp.send with a frame id to the child session", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("https://a.example/");

        await a.send(tab, "Page.enable", undefined);
        const session = backend.sessions.get(tab);

        if (session) session.reply = mainTree();

        await a.listFrames(tab);
        const child = backend.childHandles[0]?.addChild("cross", true, CROSS);

        await a.listFrames(tab);
        await a.send(tab, "Runtime.evaluate", { expression: "1" }, undefined, "cross");

        expect(child?.sent.filter((call) => call.method === "Runtime.evaluate")).toHaveLength(1);
        expect(session?.sent.map((call) => call.method)).not.toContain("Runtime.evaluate");
    });

    it("answers an unknown frame id with not_found", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("https://a.example/");

        await a.send(tab, "Page.enable", undefined);
        const session = backend.sessions.get(tab);

        if (session) session.reply = mainTree();

        await a.listFrames(tab);
        expect(await code(a.send(tab, "Page.enable", undefined, undefined, "nope"))).toBe(
            ErrorCode.notFound,
        );
        expect(await code(a.send(tab, "Page.enable", undefined, undefined, "same"))).toBe(
            ErrorCode.notFound,
        );
    });

    it("surfaces the child attach failure for a frame id instead of unknown frame", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("https://a.example/");

        backend.failures.attachChildren = [
            new Error("auto attach refused"),
            new Error("auto attach refused"),
        ];
        await a.send(tab, "Page.enable", undefined);

        const error = await a
            .send(tab, "Page.enable", undefined, undefined, "cross")
            .catch((caught: unknown) => caught);

        expect(String((error as Error).message)).toContain("auto attach refused");
    });

    it("matches an unnamed child session by its own frame tree when a frame id is routed", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("https://a.example/");

        await a.send(tab, "Page.enable", undefined);
        const session = backend.sessions.get(tab);

        if (session) session.reply = mainTree();

        await a.listFrames(tab);
        const child = backend.childHandles[0]?.addChild("cross", false);

        await a.send(tab, "Runtime.evaluate", { expression: "1" }, undefined, "cross");

        expect(child?.sent.map((call) => call.method)).toEqual([
            "Page.enable",
            "Page.getFrameTree",
            "Runtime.evaluate",
        ]);
        expect(backend.childHandles[0]?.confirmed).toEqual(["child-cross"]);
    });

    it("lists a cross site frame that only its child session knows, under its parent", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("https://a.example/");

        await a.send(tab, "Page.enable", undefined);
        const session = backend.sessions.get(tab);

        if (session) session.reply = mainTree();

        await a.listFrames(tab);
        backend.childHandles[0]?.addChild("cross", false, CROSS);

        expect(await a.listFrames(tab)).toEqual([
            { frameId: "main", parentFrameId: undefined, url: "https://a.example/", name: "", isolated: false, truncated: false },
            { frameId: "same", parentFrameId: "main", url: "https://a.example/inner", name: "inner", isolated: false, truncated: false },
            { frameId: "cross", parentFrameId: "main", url: "https://b.example/", name: "pay", isolated: true, truncated: false },
        ]);
    });

    it("targets a cross site frame by id before the frames were listed", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("https://a.example/");

        await a.send(tab, "Page.enable", undefined);
        await a.listFrames(tab);
        const child = backend.childHandles[0]?.addChild("cross", false, CROSS);

        await a.send(tab, "Runtime.evaluate", { expression: "1" }, undefined, "cross");

        expect(child?.sent.filter((call) => call.method === "Runtime.evaluate")).toHaveLength(1);
    });

    it("lists the frames inside a cross site frame as isolated too", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("https://a.example/");

        await a.send(tab, "Page.enable", undefined);
        await a.listFrames(tab);
        const child = backend.childHandles[0]?.addChild("cross", true, CROSS);

        if (child) {
            child.reply = (method) =>
                method === "Page.getFrameTree"
                    ? {
                        frameTree: {
                            frame      : { id: "cross", parentId: "main", url: "https://b.example/", name: "pay" },
                            childFrames: [{ frame: { id: "inside", parentId: "cross", url: "https://b.example/in", name: "in" } }],
                        },
                    }
                    : undefined;
        }

        const frames = await a.listFrames(tab);

        const isolated = frames.filter((frame) => frame.isolated);

        expect(isolated.map((frame) => [frame.frameId, frame.parentFrameId]))
            .toEqual([["cross", "main"], ["inside", "cross"]]);
    });

    it("keeps a child session unmatched until its frame tree answers", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("https://a.example/");

        await a.send(tab, "Page.enable", undefined);
        const session = backend.sessions.get(tab);

        if (session) session.reply = mainTree();

        await a.listFrames(tab);
        const child = backend.childHandles[0]?.addChild("late", false, CROSS);
        const answer = child?.reply;

        if (child) child.reply = () => ({ frameTree: {} });

        await a.listFrames(tab);
        expect(backend.childHandles[0]?.confirmed).toEqual([]);
        expect(await code(a.send(tab, "Page.enable", undefined, undefined, "late"))).toBe(
            ErrorCode.notFound,
        );

        if (child) child.reply = answer;

        await a.listFrames(tab);
        expect(backend.childHandles[0]?.confirmed).toEqual(["child-late"]);
        expect(
            (await a.listFrames(tab)).find((frame) => frame.frameId === "late"),
        ).toMatchObject({ isolated: true });
    });

    it("keeps child sessions of one session away from another", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const b = await open("b");
        const tab = await a.createTab("https://a.example/");

        await a.send(tab, "Page.enable", undefined);
        const session = backend.sessions.get(tab);

        if (session) session.reply = mainTree();

        await a.listFrames(tab);
        backend.childHandles[0]?.addChild("cross", true, CROSS);
        await a.listFrames(tab);
        expect(await code(b.send(tab, "Page.enable", undefined, undefined, "cross"))).toBe(
            ErrorCode.notOwned,
        );
        expect(await code(b.listFrames(tab))).toBe(ErrorCode.notOwned);
    });

    it("forwards child session events with the frame id", async () => {
        const { backend, emitted, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("https://a.example/");

        await a.send(tab, "Page.enable", undefined);
        const session = backend.sessions.get(tab);

        if (session) session.reply = mainTree();

        await a.listFrames(tab);
        const child = backend.childHandles[0]?.addChild("cross", true, CROSS);

        await a.listFrames(tab);
        await a.subscribe(tab, "Page.loadEventFired", "cross");
        child?.emit("Page.loadEventFired", { timestamp: 3 });

        expect(emitted.a).toEqual([
            {
                event : "cdp.event",
                params: {
                    targetId: tab,
                    event   : "Page.loadEventFired",
                    params  : { timestamp: 3 },
                    frameId : "cross",
                },
            },
        ]);
        a.unsubscribe(tab, "Page.loadEventFired", "cross");
        child?.emit("Page.loadEventFired", { timestamp: 4 });
        expect(emitted.a).toHaveLength(1);
    });

    it("drops the frame mapping when the child session detaches", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("https://a.example/");

        await a.send(tab, "Page.enable", undefined);
        const session = backend.sessions.get(tab);

        if (session) session.reply = mainTree();

        await a.listFrames(tab);
        backend.childHandles[0]?.addChild("cross", true, CROSS);
        await a.listFrames(tab);
        backend.childHandles[0]?.removeChild("cross");
        const frames = await a.listFrames(tab);

        expect(frames.find((frame) => frame.frameId === "cross")).toBeUndefined();
        expect(await code(a.send(tab, "Page.enable", undefined, undefined, "cross"))).toBe(
            ErrorCode.notFound,
        );
    });

    it("forgets frames that are gone and detaches children with the tab", async () => {
        const { backend, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("https://a.example/");

        await a.send(tab, "Page.enable", undefined);
        const session = backend.sessions.get(tab);

        if (session) session.reply = mainTree();

        await a.listFrames(tab);
        backend.childHandles[0]?.addChild("cross", true, CROSS);
        await a.listFrames(tab);

        if (session) {
            session.reply = (method) =>
                method === "Page.getFrameTree"
                    ? { frameTree: { frame: { id: "main", url: "https://a.example/" } } }
                    : { echoed: method };
        }

        backend.childHandles[0]?.removeChild("cross");
        expect(await a.listFrames(tab)).toEqual([
            { frameId: "main", parentFrameId: undefined, url: "https://a.example/", name: "", isolated: false, truncated: false },
        ]);
        backend.childHandles[0]?.addChild("cross", true, CROSS);
        await a.closeTab(tab);
        expect(backend.childHandles[0]?.detachedAll).toBe(true);
        expect(backend.log).toContain(`detachChildren ${tab}`);
    });

    it("detaches children when the session closes", async () => {
        const { backend, registry, open } = setup();
        const a = await open("a");
        const tab = await a.createTab("https://a.example/");

        await a.send(tab, "Page.enable", undefined);
        const session = backend.sessions.get(tab);

        if (session) session.reply = mainTree();

        await a.listFrames(tab);
        await registry.close("a");
        expect(backend.childHandles).toHaveLength(1);
        expect(backend.childHandles[0]?.detachedAll).toBe(true);
    });
});

describe("state shared with cross site frame sessions", () => {
    const CROSS = { url: "https://b.example/", name: "pay" };

    async function tabWithChild() {
        const made = setup();
        const a = await made.open("a");
        const tab = await a.createTab("https://a.example/");

        await a.send(tab, "Page.enable", undefined);

        return { ...made, a, tab, handle: made.backend.childHandles[0] };
    }

    const sentMethods = (session: { sent: Array<{ method: string }> } | undefined): string[] =>
        session?.sent.map((call) => call.method) ?? [];

    it("applies capture and emulation commands to children that attach later", async () => {
        const { a, tab, handle } = await tabWithChild();

        await a.send(tab, "Network.enable", {});
        await a.send(tab, "Network.setBlockedURLs", { urls: ["*.png"] });
        const child = handle?.addChild("cross", true, CROSS);

        await handle?.settled();

        expect(child?.sent).toEqual([
            expect.objectContaining({ method: "Page.enable" }),
            expect.objectContaining({ method: "Network.enable" }),
            expect.objectContaining({ method: "Network.setBlockedURLs", params: { urls: ["*.png"] } }),
        ]);
    });

    it("applies a command to children that already exist and keeps only its latest value", async () => {
        const { a, tab, handle } = await tabWithChild();
        const child = handle?.addChild("cross", true, CROSS);

        await handle?.settled();
        await a.send(tab, "Fetch.enable", { patterns: [{ urlPattern: "*/a" }] });
        await a.send(tab, "Fetch.enable", { patterns: [{ urlPattern: "*/b" }] });
        const late = handle?.addChild("late", true, CROSS);

        await handle?.settled();

        expect(child?.sent.filter((call) => call.method === "Fetch.enable")).toHaveLength(2);
        expect(late?.sent.filter((call) => call.method === "Fetch.enable")).toEqual([
            expect.objectContaining({ params: { patterns: [{ urlPattern: "*/b" }] } }),
        ]);
    });

    it("stops replaying a domain after it is disabled and tells existing children", async () => {
        const { a, tab, handle } = await tabWithChild();
        const child = handle?.addChild("cross", true, CROSS);

        await handle?.settled();
        await a.send(tab, "Fetch.enable", { patterns: [] });
        await a.send(tab, "Fetch.disable", {});
        const late = handle?.addChild("late", true, CROSS);

        await handle?.settled();

        expect(sentMethods(child)).toContain("Fetch.disable");
        expect(sentMethods(late)).not.toContain("Fetch.enable");
    });

    it("does not copy commands that only belong to the tab session", async () => {
        const { a, tab, handle } = await tabWithChild();
        const child = handle?.addChild("cross", true, CROSS);

        await handle?.settled();
        await a.send(tab, "Runtime.evaluate", { expression: "1" });
        await a.send(tab, "Emulation.setDeviceMetricsOverride", { width: 1 });

        expect(sentMethods(child)).not.toContain("Runtime.evaluate");
        expect(sentMethods(child)).not.toContain("Emulation.setDeviceMetricsOverride");
    });

    it("forwards network and console events of child sessions under the tab", async () => {
        const { a, emitted, tab, handle } = await tabWithChild();

        await a.subscribe(tab, "Network.requestWillBeSent");
        await a.subscribe(tab, "Runtime.consoleAPICalled");
        await a.subscribe(tab, "Page.loadEventFired");
        const child = handle?.addChild("cross", true, CROSS);

        await handle?.settled();
        child?.emit("Network.requestWillBeSent", { requestId: "1.1" });
        child?.emit("Runtime.consoleAPICalled", { type: "log" });
        child?.emit("Page.loadEventFired", { timestamp: 1 });

        expect(emitted.a).toEqual([
            { event: "cdp.event", params: { targetId: tab, event: "Network.requestWillBeSent", params: { requestId: "1.1" } } },
            { event: "cdp.event", params: { targetId: tab, event: "Runtime.consoleAPICalled", params: { type: "log" } } },
        ]);
    });

    it("forwards events of a child that was already there when the subscription started", async () => {
        const { a, emitted, tab, handle } = await tabWithChild();
        const child = handle?.addChild("cross", true, CROSS);

        await handle?.settled();
        await a.subscribe(tab, "Network.requestWillBeSent");
        child?.emit("Network.requestWillBeSent", { requestId: "1.1" });
        a.unsubscribe(tab, "Network.requestWillBeSent");
        child?.emit("Network.requestWillBeSent", { requestId: "1.2" });

        expect(emitted.a).toHaveLength(1);
        expect(child?.listenerCount("Network.requestWillBeSent")).toBe(0);
    });

    it("answers a paused request on the child session that raised it", async () => {
        const { a, tab, handle, backend } = await tabWithChild();

        await a.subscribe(tab, "Fetch.requestPaused");
        const child = handle?.addChild("cross", true, CROSS);

        await handle?.settled();
        child?.emit("Fetch.requestPaused", { requestId: "interception-1" });
        await a.send(tab, "Fetch.fulfillRequest", { requestId: "interception-1", responseCode: 200 });
        await a.send(tab, "Fetch.continueRequest", { requestId: "interception-main" });

        expect(child?.sent.filter((call) => call.method === "Fetch.fulfillRequest")).toHaveLength(1);
        expect(sentMethods(backend.sessions.get(tab))).toContain("Fetch.continueRequest");
        expect(sentMethods(child)).not.toContain("Fetch.continueRequest");
    });

    it("answers a dialog on the child session that opened it", async () => {
        const { a, tab, handle, backend } = await tabWithChild();

        await a.subscribe(tab, "Page.javascriptDialogOpening");
        await a.subscribe(tab, "Page.javascriptDialogClosed");
        const child = handle?.addChild("cross", true, CROSS);

        await handle?.settled();
        child?.emit("Page.javascriptDialogOpening", { message: "hi" });
        await a.send(tab, "Page.handleJavaScriptDialog", { accept: true });
        child?.emit("Page.javascriptDialogClosed", { result: true });
        await a.send(tab, "Page.handleJavaScriptDialog", { accept: true });

        expect(child?.sent.filter((call) => call.method === "Page.handleJavaScriptDialog")).toHaveLength(1);
        expect(
            backend.sessions.get(tab)?.sent.filter((call) => call.method === "Page.handleJavaScriptDialog"),
        ).toHaveLength(1);
    });

    it("forgets what a child raised once it detaches", async () => {
        const { a, tab, handle, backend } = await tabWithChild();

        await a.subscribe(tab, "Fetch.requestPaused");
        const child = handle?.addChild("cross", true, CROSS);

        await handle?.settled();
        child?.emit("Fetch.requestPaused", { requestId: "interception-1" });
        handle?.removeChild("cross");
        await a.send(tab, "Fetch.continueRequest", { requestId: "interception-1" });

        expect(sentMethods(backend.sessions.get(tab))).toContain("Fetch.continueRequest");
        expect(child?.listenerCount("Fetch.requestPaused")).toBe(0);
    });

    it("keeps a failing child from failing the command on the tab", async () => {
        const { a, tab, handle } = await tabWithChild();
        const child = handle?.addChild("cross", true, CROSS);

        if (child) child.failure = new Error("gone");

        await expect(a.send(tab, "Network.enable", {})).resolves.toBeDefined();
    });
});
