import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import { SessionRegistry } from "../src/daemon/sessions.js";
import { checkGuardedCall, NO_SAFETY, type SessionSafety } from "../src/daemon/cdp-safety.js";
import { checkUploadPaths } from "../src/daemon/upload-safety.js";
import { FakeBackend } from "./helpers/fake-backend.js";

const safe = (patch: Partial<SessionSafety>): SessionSafety => ({ ...NO_SAFETY, ...patch });

function refusal(action: () => unknown): string | undefined {
    try {
        action();
    } catch (error) {
        if (error instanceof RpcError) return error.message;

        throw error;
    }

    return undefined;
}

describe("guarded CDP methods", () => {
    it.each([
        "Network.getCookies",
        "Network.setCookie",
        "Network.deleteCookies",
        "DOM.setFileInputFiles",
    ])("guards %s", (method) => {
        const safety = safe({ confirmDangerous: true, uploadDirs: [] });

        expect(refusal(() =>
            checkGuardedCall({ method, params: {}, safety, confirmed: false }),
        )).toContain("confirmation");
    });

    it("does not guard ordinary methods", () => {
        expect(refusal(() =>
            checkGuardedCall({ method: "Runtime.evaluate", params: {}, safety: safe({ readOnly: true }), confirmed: false }),
        )).toBeUndefined();
    });

    it("refuses writes but not cookie reads in read-only mode", () => {
        const safety = safe({ readOnly: true });
        const call = (method: string) => () =>
            checkGuardedCall({ method, params: {}, safety, confirmed: false });

        expect(refusal(call("Network.getCookies"))).toBeUndefined();
        expect(refusal(call("Network.setCookie"))).toContain("safety.readOnly");
        expect(refusal(call("Network.deleteCookies"))).toContain("safety.readOnly");
        expect(refusal(call("DOM.setFileInputFiles"))).toContain("safety.readOnly");
    });

    it("needs confirmation for every guarded method when confirmDangerous is on", () => {
        const safety = safe({ confirmDangerous: true, uploadDirs: [] });
        const call = (method: string, confirmed: boolean) => () =>
            checkGuardedCall({ method, params: {}, safety, confirmed });

        for (const method of ["Network.getCookies", "Network.setCookie", "DOM.setFileInputFiles"]) {
            expect(refusal(call(method, false))).toContain("confirmation");
            expect(refusal(call(method, true))).toBeUndefined();
        }
    });

    it("checks the tab and the cookie target against the allowlist", () => {
        const safety = safe({ allowedDomains: ["example.com", "*.example.com"] });
        const write = (params: Record<string, unknown>, tabUrl: string | undefined) => () =>
            checkGuardedCall({ method: "Network.setCookie", params, safety, confirmed: false, tabUrl });

        expect(refusal(write({ url: "https://a.example.com/" }, "https://example.com/"))).toBeUndefined();
        expect(refusal(write({ domain: ".example.com" }, "https://example.com/"))).toBeUndefined();
        expect(refusal(write({ url: "https://evil.test/" }, "https://example.com/"))).toContain("evil.test");
        expect(refusal(write({ domain: "evil.test" }, "https://example.com/"))).toContain("evil.test");
        expect(refusal(write({ url: "https://example.com/" }, "https://evil.test/"))).toContain("evil.test");
        expect(refusal(write({ url: "https://example.com/" }, undefined))).toContain("tab URL is unknown");
    });

    it("checks the tab and frame of a file attachment and checks the tab of a cookie read too", () => {
        const safety = safe({ allowedDomains: ["example.com"] });
        const attach = (frameUrl: string | undefined) => () =>
            checkGuardedCall({ method: "DOM.setFileInputFiles", params: {}, safety, confirmed: false, tabUrl: "https://example.com/", frameUrl });

        expect(refusal(attach(undefined))).toBeUndefined();
        expect(refusal(attach("about:srcdoc"))).toBeUndefined();
        expect(refusal(attach("https://evil.test/f"))).toContain("evil.test");
        const read = (tabUrl: string | undefined) => () =>
            checkGuardedCall({ method: "Network.getCookies", params: {}, safety, confirmed: false, tabUrl });

        expect(refusal(read("https://example.com/"))).toBeUndefined();
        expect(refusal(read("https://evil.test/"))).toContain("evil.test");
        expect(refusal(read(undefined))).toContain("tab URL is unknown");
    });

    it("lets a cookie read through when no domain rule is set", () => {
        expect(refusal(() =>
            checkGuardedCall({
                method   : "Network.getCookies",
                params   : {},
                safety   : safe({}),
                confirmed: false,
                tabUrl   : "https://anything.test/",
            }),
        )).toBeUndefined();
    });
});

describe("session safety in the daemon", () => {
    async function open(safety: SessionSafety, options: {
        platform?         : NodeJS.Platform;
        resolveUploadPath?: (path: string) => Promise<string>;
    } = {}) {
        const backend = new FakeBackend();
        const registry = new SessionRegistry<string>(backend, { allowFocus: false, ...options });
        const session = await registry.open("a", () => undefined, {
            isolated  : false,
            clientName: "a",
            safety,
        });

        return { backend, session };
    }

    async function failure(promise: Promise<unknown>): Promise<RpcError | undefined> {
        const error = await promise.then(() => undefined, (caught: unknown) => caught);

        return error instanceof RpcError ? error : undefined;
    }

    it("refuses a direct file attachment outside the upload directories", async () => {
        const { session, backend } = await open(safe({ uploadDirs: ["/allowed"] }), {
            platform: "linux", resolveUploadPath: async (path) => path,
        });
        const tab = await session.createTab("https://example.com/");
        const result = await failure(session.send({
            targetId: tab, method: "DOM.setFileInputFiles", params: { files: ["/outside/secret"], nodeId: 1 },
        }));

        expect(result?.code).toBe(ErrorCode.forbiddenMethod);
        expect(backend.log.some((entry) => entry.includes("DOM.setFileInputFiles"))).toBe(false);
    });

    it("checks real paths and permits files inside the upload directories", async () => {
        const resolve = async (path: string) => path === "/allowed/link" ? "/outside/secret" : path;

        await expect(checkUploadPaths(["/allowed/link"], ["/allowed"], "linux", resolve)).rejects.toThrow();
        await expect(checkUploadPaths(["/allowed-other/file"], ["/allowed"], "linux", resolve)).rejects.toThrow();
        await expect(checkUploadPaths(["/allowed/file"], ["/allowed"], "linux", resolve)).resolves.toEqual(["/allowed"]);
    });

    it("checks Windows paths without depending on the host platform", async () => {
        const resolve = async (path: string) => path;

        await expect(checkUploadPaths(["c:\\allowed\\file.txt"], ["C:\\Allowed"], "win32", resolve))
            .resolves.toEqual(["C:\\Allowed"]);
        await expect(checkUploadPaths(["C:\\Outside\\file.txt"], ["C:\\Allowed"], "win32", resolve))
            .rejects.toThrow();
    });

    it("uses a valid upload directory even when another cannot be resolved", async () => {
        const resolve = async (path: string) => {
            if (path === "/missing") throw new Error("missing");

            return path;
        };

        await expect(checkUploadPaths(["/allowed/file"], ["/missing", "/allowed"], "linux", resolve))
            .resolves.toEqual(["/allowed"]);
    });

    it("refuses malformed or unresolvable paths when upload directories are set", async () => {
        const { session } = await open(safe({ uploadDirs: ["/allowed"] }), {
            platform: "linux", resolveUploadPath: async () => { throw new Error("unavailable"); },
        });
        const tab = await session.createTab("https://example.com/");
        const attach = (files: unknown) => session.send({
            targetId: tab, method: "DOM.setFileInputFiles", params: { files, nodeId: 1 },
        });

        expect((await failure(attach([12])))?.code).toBe(ErrorCode.forbiddenMethod);
        expect((await failure(attach(["/allowed/file"])))?.code).toBe(ErrorCode.forbiddenMethod);
        await expect(attach([])).resolves.toMatchObject({ echoed: "DOM.setFileInputFiles" });
    });

    it("refuses tab creation in read-only mode and outside the allowlist", async () => {
        const readOnly = await open(safe({ readOnly: true }));

        expect((await failure(readOnly.session.createTab("about:blank")))?.code).toBe(ErrorCode.forbiddenMethod);

        const restricted = await open(safe({ allowedDomains: ["example.com"] }));

        expect((await failure(restricted.session.createTab("https://evil.test/")))?.message).toContain("evil.test");
        await expect(restricted.session.createTab("https://example.com/")).resolves.toMatch(/./);
        await expect(restricted.session.createTab("about:blank")).resolves.toMatch(/./);
    });

    it("refuses Page.navigate outside the allowlist before it reaches the browser", async () => {
        const { backend, session } = await open(safe({ allowedDomains: ["example.com"] }));
        const tab = await session.createTab("about:blank");

        const error = await failure(session.send({ targetId: tab, method: "Page.navigate", params: { url: "https://evil.test/" } }));

        expect(error?.code).toBe(ErrorCode.forbiddenMethod);
        expect(backend.log.join("\n")).not.toContain("attach");
        await expect(session.send({ targetId: tab, method: "Page.navigate", params: { url: "https://example.com/" } })).resolves.toMatchObject({ echoed: "Page.navigate" });
    });

    it("refuses a denied host and a private address when a tab is created or navigated", async () => {
        const { backend, session } = await open(
            safe({ deniedDomains: ["bad.test"], allowPrivateNetworks: false }),
        );

        expect((await failure(session.createTab("https://bad.test/")))?.message)
            .toContain("safety.deniedDomains");
        expect((await failure(session.createTab("http://127.0.0.1:3000/")))?.message)
            .toContain("safety.allowPrivateNetworks");
        expect((await failure(session.createTab("http://169.254.169.254/")))?.code)
            .toBe(ErrorCode.forbiddenMethod);
        await expect(session.createTab("https://example.com/")).resolves.toMatch(/./);

        const tab = await session.createTab("about:blank");
        const moved = await failure(
            session.send({ targetId: tab, method: "Page.navigate", params: { url: "http://localhost/" } }),
        );

        expect(moved?.code).toBe(ErrorCode.forbiddenMethod);
        expect(backend.log.join("\n")).not.toContain("localhost");
    });

    it("opens a private address once the session allows private networks or names the host", async () => {
        const open1 = await open(safe({ allowPrivateNetworks: true }));
        const named = await open(
            safe({ allowedDomains: ["localhost:3000"], allowPrivateNetworks: false }),
        );

        await expect(open1.session.createTab("http://127.0.0.1:3000/")).resolves.toMatch(/./);
        await expect(named.session.createTab("http://localhost:3000/")).resolves.toMatch(/./);
        expect((await failure(named.session.createTab("http://localhost:4000/")))?.message)
            .toContain("safety.allowedDomains");
    });

    it("refuses cookie writes for a denied host", () => {
        const safety = safe({ deniedDomains: ["bad.test"] });
        const write = (params: Record<string, unknown>) => () =>
            checkGuardedCall({
                method   : "Network.setCookie",
                params,
                safety,
                confirmed: false,
                tabUrl   : "https://example.com/",
            });

        expect(refusal(write({ url: "https://bad.test/" }))).toContain("safety.deniedDomains");
        expect(refusal(write({ domain: ".bad.test" }))).toContain("safety.deniedDomains");
        expect(refusal(write({ url: "https://example.com/" }))).toBeUndefined();
    });

    it("refuses a cookie read for a tab that is outside the rules, with the real tab URL", async () => {
        const { session, backend } = await open(safe({ allowedDomains: ["example.com"] }));
        const tab = await session.createTab("https://example.com/");

        await expect(
            session.send({ targetId: tab, method: "Network.getCookies", params: {} }),
        ).resolves.toMatchObject({ echoed: "Network.getCookies" });

        const entry = backend.targets.get(tab);

        if (entry === undefined) throw new Error("missing target");

        entry.url = "https://evil.test/";

        const moved = await failure(
            session.send({ targetId: tab, method: "Network.getCookies", params: {} }),
        );

        expect(moved?.code).toBe(ErrorCode.forbiddenMethod);
        expect(moved?.message).toContain("evil.test");
    });

    it("enforces the cookie and file policy with the real tab URL", async () => {
        const { session, backend } = await open(safe({ allowedDomains: ["example.com"], deniedDomains: [], allowPrivateNetworks: true, confirmDangerous: true, uploadDirs: [] }));
        const tab = await session.createTab("https://example.com/");

        const unconfirmed = await failure(session.send({ targetId: tab, method: "Network.setCookie", params: { name: "a", value: "b", url: "https://example.com/" } }));

        expect(unconfirmed?.message).toContain("confirmation");

        await expect(
            session.send({ targetId: tab, method: "Network.setCookie", params: { name: "a", value: "b", url: "https://example.com/" }, confirmed: true }),
        ).resolves.toMatchObject({ echoed: "Network.setCookie" });

        const stranger = await failure(
            session.send({ targetId: tab, method: "Network.setCookie", params: { name: "a", value: "b", domain: "evil.test" }, confirmed: true }),
        );

        expect(stranger?.message).toContain("evil.test");
        expect(stranger?.message).not.toContain("value");

        const entry = backend.targets.get(tab);

        if (entry === undefined) throw new Error("missing target");

        entry.url = "https://evil.test/";

        const moved = await failure(
            session.send({ targetId: tab, method: "DOM.setFileInputFiles", params: { files: ["/tmp/x"], nodeId: 1 }, confirmed: true }),
        );

        expect(moved?.message).toContain("evil.test");
    });
});
