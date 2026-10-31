import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpClient, CdpProtocolError, CdpTimeoutError } from "../src/cdp/index.js";
import { CdpBackend, DaemonError } from "../src/daemon/index.js";
import { FakeBrowser } from "./helpers/fake-browser.js";

const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined);
});

async function setup(configure?: (browser: FakeBrowser) => void) {
    const browser = new FakeBrowser();

    configure?.(browser);
    const url = await browser.start();

    stops.push(() => browser.stop());
    const client = await CdpClient.connect({ url, requestTimeoutMs: 2000 });

    stops.push(() => client.close());
    const backend = await CdpBackend.create(client);

    return { browser, client, backend };
}

describe("create", () => {
    it("starts target discovery and reads the default context", async () => {
        const { browser } = await setup();

        expect(browser.calls.map((call) => call.method)).toEqual([
            "Target.setDiscoverTargets",
            "Target.getBrowserContexts",
        ]);
        expect(browser.calls[0]?.params).toEqual({ discover: true });
    });

    it("refuses a browser that does not report its default context", async () => {
        const browser = new FakeBrowser();

        browser.reportDefaultContext = false;
        const url = await browser.start();

        stops.push(() => browser.stop());
        const client = await CdpClient.connect({ url, requestTimeoutMs: 2000 });

        stops.push(() => client.close());
        await expect(CdpBackend.create(client)).rejects.toThrow(/default browser context/);
    });

    it("rejects a malformed response from the browser", async () => {
        const browser = new FakeBrowser();

        browser.malformed.add("Target.getBrowserContexts");
        const url = await browser.start();

        stops.push(() => browser.stop());
        const client = await CdpClient.connect({ url, requestTimeoutMs: 2000 });

        stops.push(() => client.close());
        const failure = await CdpBackend.create(client).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(DaemonError);
    });
});

describe("contexts and targets", () => {
    it("creates and disposes isolated contexts", async () => {
        const { browser, backend } = await setup();
        const id = await backend.createContext();

        expect(browser.contexts.has(id)).toBe(true);
        await backend.disposeContext(id);
        expect(browser.contexts.has(id)).toBe(false);
        expect(browser.calls.at(-1)).toMatchObject({
            method: "Target.disposeBrowserContext",
            params: { browserContextId: id },
        });
    });

    it("opens every tab in the background", async () => {
        const { browser, backend } = await setup();
        const context = await backend.createContext();

        await backend.createTarget("https://a.example/", undefined);
        await backend.createTarget("https://b.example/", context);
        const created = browser.calls.filter((call) => call.method === "Target.createTarget");

        expect(created.map((call) => call.params)).toEqual([
            { url: "https://a.example/", background: true },
            { url: "https://b.example/", background: true, browserContextId: context },
        ]);
    });

    it("never activates or focuses anything", async () => {
        const { browser, backend } = await setup();
        const id = await backend.createTarget("https://a.example/", undefined);

        await backend.listTargets();
        await backend.closeTarget(id);
        const methods = browser.calls.map((call) => call.method).join(" ");

        expect(methods).not.toMatch(/activate|bringToFront|setWindowBounds/i);
    });

    it("passes through the error of the browser for a target that is already gone", async () => {
        const { backend } = await setup();
        const id = await backend.createTarget("https://a.example/", undefined);

        await backend.closeTarget(id);
        const failure = await backend.closeTarget(id).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(CdpProtocolError);
        expect(failure).toMatchObject({ code: -32602 });
        await expect(backend.attach("missing")).rejects.toBeInstanceOf(CdpProtocolError);
        await expect(backend.disposeContext("missing")).rejects.toBeInstanceOf(CdpProtocolError);
    });

    it("skips malformed entries of the target list instead of failing", async () => {
        const { browser, backend } = await setup();
        const good = browser.addTarget("page", "https://good.example/", browser.defaultContext);
        const nullContext = browser.addTarget("page", "https://null.example/", browser.defaultContext);
        const entry = browser.targets.get(nullContext);

        if (entry) (entry as { browserContextId: unknown }).browserContextId = null;

        browser.targets.set("BROKEN", { type: 5, url: 7 } as unknown as Parameters<
      typeof browser.targets.set
        >[1]);
        const listed = await backend.listTargets();

        expect(listed.map((target) => target.url).sort()).toEqual([
            "https://good.example/",
            "https://null.example/",
        ]);
        expect(listed.find((target) => target.targetId === nullContext)?.contextId).toBeUndefined();
        expect(listed.find((target) => target.targetId === good)?.contextId).toBeUndefined();
    });

    it("closes a target", async () => {
        const { browser, backend } = await setup();
        const id = await backend.createTarget("https://a.example/", undefined);

        await backend.closeTarget(id);
        expect(browser.targets.has(id)).toBe(false);
    });

    it("lists pages only and hides DevTools windows", async () => {
        const { browser, backend } = await setup();

        browser.addTarget("page", "https://user.example/", browser.defaultContext);
        browser.addTarget("service_worker", "https://sw.example/sw.js", browser.defaultContext);
        browser.addTarget("browser", "", undefined);
        browser.addTarget("iframe", "https://frame.example/", browser.defaultContext);
        browser.addTarget("page", "devtools://devtools/bundled/inspector.html", browser.defaultContext);
        const targets = await backend.listTargets();

        expect(targets.map((target) => target.url)).toEqual(["https://user.example/"]);
    });

    it("reports the default context as undefined and keeps other context ids", async () => {
        const { browser, backend } = await setup();
        const context = await backend.createContext();

        browser.addTarget("page", "https://shared.example/", browser.defaultContext);
        browser.addTarget("page", "https://isolated.example/", context);
        browser.addTarget("page", "https://private.example/", "someone-elses-context");
        browser.addTarget("page", "https://legacy.example/", undefined);
        const byUrl = Object.fromEntries(
            (await backend.listTargets()).map((target) => [target.url, target.contextId]),
        );

        expect(byUrl).toEqual({
            "https://shared.example/"  : undefined,
            "https://isolated.example/": context,
            "https://private.example/" : "someone-elses-context",
            "https://legacy.example/"  : undefined,
        });
    });

    it("fills in empty titles and urls", async () => {
        const { browser, backend } = await setup();
        const id = browser.addTarget("page", "", browser.defaultContext);
        const target = browser.targets.get(id);

        if (target) target.title = "";

        expect(await backend.listTargets()).toEqual([
            { targetId: id, url: "", title: "", contextId: undefined },
        ]);
    });

    it("surfaces CDP errors as CdpProtocolError", async () => {
        const { browser, backend } = await setup();

        browser.failures.set("Target.createTarget", { code: -32000, message: "Failed to open" });
        await expect(backend.createTarget("https://a.example/", undefined)).rejects.toBeInstanceOf(
            CdpProtocolError,
        );
    });

    it("rejects malformed responses instead of passing them on", async () => {
        const { browser, backend } = await setup();

        browser.malformed.add("Target.createTarget");
        browser.malformed.add("Target.createBrowserContext");
        browser.malformed.add("Target.getTargets");
        await expect(backend.createTarget("https://a.example/", undefined)).rejects.toBeInstanceOf(
            DaemonError,
        );
        await expect(backend.createContext()).rejects.toBeInstanceOf(DaemonError);
        await expect(backend.listTargets()).rejects.toBeInstanceOf(DaemonError);
    });
});

describe("events", () => {
    it("reports destroyed targets, also when a context is disposed", async () => {
        const { backend } = await setup();
        const seen: string[] = [];

        backend.onTargetDestroyed((id) => seen.push(id));
        const first = await backend.createTarget("https://a.example/", undefined);
        const context = await backend.createContext();
        const second = await backend.createTarget("https://b.example/", context);

        await backend.closeTarget(first);
        await backend.disposeContext(context);
        await vi.waitFor(() => expect(seen).toEqual([first, second]));
    });

    it("reports targets that the user closes", async () => {
        const { browser, backend } = await setup();
        const seen: string[] = [];

        backend.onTargetDestroyed((id) => seen.push(id));
        const id = browser.addTarget("page", "https://user.example/", browser.defaultContext);

        browser.destroyFromOutside(id);
        await vi.waitFor(() => expect(seen).toEqual([id]));
    });

    it("stops reporting after unsubscribe", async () => {
        const { client, backend } = await setup();
        const handler = vi.fn();
        const off = backend.onTargetDestroyed(handler);

        off();
        const id = await backend.createTarget("https://a.example/", undefined);

        await backend.closeTarget(id);
        await client.send("Target.getTargets");
        expect(handler).not.toHaveBeenCalled();
    });

    it("ignores malformed destroy events", async () => {
        const { browser, client, backend } = await setup();
        const handler = vi.fn();

        backend.onTargetDestroyed(handler);
        browser.emitRaw("Target.targetDestroyed", {});
        browser.emitRaw("Target.targetDestroyed", { targetId: 5 });
        browser.emitRaw("Target.targetDestroyed", null);
        await client.send("Target.getTargets");
        expect(handler).not.toHaveBeenCalled();
    });

    it("notifies when the browser connection drops", async () => {
        const { browser, backend } = await setup();
        const handler = vi.fn();

        backend.onDisconnected(handler);
        browser.dropConnections();
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    });

    it("notifies when the backend is closed", async () => {
        const { backend } = await setup();
        const handler = vi.fn();

        backend.onDisconnected(handler);
        await backend.close();
        expect(handler).toHaveBeenCalledTimes(1);
    });
});

describe("attached sessions", () => {
    it("sends commands through the flattened session of the target", async () => {
        const { browser, backend } = await setup();
        const id = await backend.createTarget("https://a.example/", undefined);
        const session = await backend.attach(id);

        await expect(session.send("Page.enable", { a: 1 }, 1500)).resolves.toEqual({
            echoed: "Page.enable",
        });
        const sent = browser.calls.find((call) => call.method === "Page.enable");

        expect(sent?.sessionId).toMatch(/^S/);
        expect(sent?.params).toEqual({ a: 1 });
    });

    it("applies the timeout of the call to a command that gets no answer", async () => {
        const { browser, backend } = await setup();
        const id = await backend.createTarget("https://a.example/", undefined);
        const session = await backend.attach(id);

        browser.silent.add("Page.navigate");
        const failure = await session
            .send("Page.navigate", undefined, 50)
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(CdpTimeoutError);
        expect(failure).toMatchObject({ timeoutMs: 50 });
    });

    it("delivers events of the session and stops after unsubscribe", async () => {
        const { browser, backend } = await setup();
        const id = await backend.createTarget("https://a.example/", undefined);
        const session = await backend.attach(id);
        const seen: unknown[] = [];
        const off = session.on("Page.loadEventFired", (params) => seen.push(params));

        browser.emitSessionEvent(id, "Page.loadEventFired", { timestamp: 1 });
        await vi.waitFor(() => expect(seen).toEqual([{ timestamp: 1 }]));
        off();
        browser.emitSessionEvent(id, "Page.loadEventFired", { timestamp: 2 });
        await session.send("Page.enable", undefined);
        expect(seen).toHaveLength(1);
    });

    it("detaches from the target", async () => {
        const { browser, backend } = await setup();
        const id = await backend.createTarget("https://a.example/", undefined);
        const session = await backend.attach(id);

        await session.detach();
        expect(browser.calls.some((call) => call.method === "Target.detachFromTarget")).toBe(true);
    });
});
