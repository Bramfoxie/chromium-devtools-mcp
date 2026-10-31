import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpClosedError, CdpProtocolError, CdpTimeoutError } from "../src/cdp/index.js";
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
    const open = async (key: string, isolated = false) => {
        emitted[key] = [];

        const emit = (event: string, params?: unknown) => emitted[key]?.push({ event, params });

        return registry.open(key, emit, isolated);
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
        "Browser.getVersion",
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
        expect(backend.sessions.get(tab)?.listenerCount("Page.loadEventFired")).toBe(0);
        backend.sessions.get(tab)?.emit("Page.loadEventFired", {});
        expect(emitted.a).toEqual([]);
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
