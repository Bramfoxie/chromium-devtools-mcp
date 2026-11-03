import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { runTool, ToolRuntime, webauthn } from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const focusing: Config = { ...managedConfig, allowFocus: true };

function setup(config: Config = managedConfig, credentials: unknown[] = []) {
    const fake = new FakeAccess({
        tabs: [{ targetId: "tab1", url: "https://a.example/", title: "t", owned: true, created: true }],
    });
    let counter = 0;

    fake.respond = (_tab, method) => {
        if (method === "WebAuthn.addVirtualAuthenticator") return { authenticatorId: `auth-${++counter}` };

        if (method === "WebAuthn.getCredentials") return { credentials };

        return {};
    };

    const runtime = new ToolRuntime({ access: fake.asAccess(), config });

    runtime.tabs.select("tab1");

    return { fake, runtime };
}

const call = (runtime: ToolRuntime, args: Record<string, unknown>) =>
    runTool(webauthn, args, extra(), runtime);

const methods = (fake: FakeAccess) => fake.sent.map((entry) => entry.method);

const browserCalls = (fake: FakeAccess) =>
    methods(fake).filter((method) => method.startsWith("WebAuthn.") || method === "Page.bringToFront");

const text = (result: { content: unknown }) => JSON.stringify(result.content);

describe("webauthn add_authenticator", () => {
    it("enables the domain once and adds a ctap2 platform authenticator for passkeys", async () => {
        const { fake, runtime } = setup();
        const first = await call(runtime, { action: "add_authenticator" });
        const second = await call(runtime, { action: "add_authenticator", transport: "usb" });

        expect(first.structuredContent).toMatchObject({ authenticatorId: "auth-1" });
        expect(second.structuredContent).toMatchObject({ authenticatorId: "auth-2" });
        expect(methods(fake).filter((method) => method === "WebAuthn.enable")).toHaveLength(1);
        expect(fake.sent.find((entry) => entry.method === "WebAuthn.enable")?.params).toEqual({
            enableUI: false,
        });

        const added = fake.sent.filter((entry) => entry.method === "WebAuthn.addVirtualAuthenticator");

        expect(added[0]?.params).toEqual({
            options: {
                protocol                   : "ctap2",
                ctap2Version               : "ctap2_1",
                transport                  : "internal",
                hasResidentKey             : true,
                hasUserVerification        : true,
                isUserVerified             : true,
                automaticPresenceSimulation: true,
            },
        });
        expect((added[1]?.params as { options: { transport: string } }).options.transport).toBe("usb");
        expect(runtime.webauthn.ids("tab1")).toEqual(["auth-1", "auth-2"]);
    });

    it("adds a u2f security key without the passkey features", async () => {
        const { fake, runtime } = setup();

        await call(runtime, { action: "add_authenticator", protocol: "u2f", userVerified: false });

        expect(fake.sent.find((entry) => entry.method === "WebAuthn.addVirtualAuthenticator")?.params).toEqual({
            options: {
                protocol                   : "u2f",
                transport                  : "usb",
                hasResidentKey             : false,
                hasUserVerification        : false,
                isUserVerified             : false,
                automaticPresenceSimulation: true,
            },
        });
    });

    it.each([
        [{ protocol: "u2f", transport: "internal" }],
        [{ protocol: "u2f", residentKey: true }],
        [{ protocol: "u2f", userVerification: true }],
    ])("refuses the u2f combination %j", async (extra) => {
        const { fake, runtime } = setup();
        const result = await call(runtime, { action: "add_authenticator", ...extra });

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("u2f authenticator is a security key");
        expect(browserCalls(fake)).toEqual([]);
    });

    it("brings the tab to the front only when asked and only with allowFocus", async () => {
        const refused = setup();
        const denied = await call(refused.runtime, { action: "add_authenticator", bringToFront: true });

        expect(denied.isError).toBe(true);
        expect(text(denied)).toContain("allowFocus");
        expect(browserCalls(refused.fake)).toEqual([]);

        const allowed = setup(focusing);

        await call(allowed.runtime, { action: "add_authenticator", bringToFront: true });

        expect(methods(allowed.fake).indexOf("Page.bringToFront")).toBeLessThan(
            methods(allowed.fake).indexOf("WebAuthn.enable"),
        );

        const quiet = setup(focusing);

        await call(quiet.runtime, { action: "add_authenticator" });

        expect(methods(quiet.fake)).not.toContain("Page.bringToFront");
    });

    it("turns the domain off again when the first authenticator cannot be added", async () => {
        const { fake, runtime } = setup();

        fake.failSend = (_tab, method) =>
            method === "WebAuthn.addVirtualAuthenticator" ? new Error("not supported") : undefined;

        const result = await call(runtime, { action: "add_authenticator" });

        expect(result.isError).toBe(true);
        expect(methods(fake).at(-1)).toBe("WebAuthn.disable");
        expect(runtime.webauthn.ids("tab1")).toEqual([]);
    });
});

describe("webauthn authenticators and credentials", () => {
    async function withAuthenticator(config: Config = managedConfig, credentials: unknown[] = []) {
        const made = setup(config, credentials);

        await call(made.runtime, { action: "add_authenticator" });
        made.fake.sent.length = 0;

        return made;
    }

    it("removes an authenticator and turns the domain off with the last one", async () => {
        const { fake, runtime } = await withAuthenticator();

        await call(runtime, { action: "add_authenticator" });
        fake.sent.length = 0;

        await call(runtime, { action: "remove_authenticator", authenticatorId: "auth-1" });
        expect(methods(fake)).toEqual(["WebAuthn.removeVirtualAuthenticator"]);

        const last = await call(runtime, { action: "remove_authenticator", authenticatorId: "auth-2" });

        expect(last.isError).not.toBe(true);
        expect(methods(fake)).toEqual([
            "WebAuthn.removeVirtualAuthenticator",
            "WebAuthn.removeVirtualAuthenticator",
            "WebAuthn.disable",
        ]);
        expect(runtime.webauthn.ids("tab1")).toEqual([]);
    });

    it("refuses an authenticator the tab does not have before it sends anything", async () => {
        const { fake, runtime } = await withAuthenticator();

        for (const action of ["remove_authenticator", "list_credentials", "clear_credentials"]) {
            const result = await call(runtime, { action, authenticatorId: "auth-9" });

            expect(result.isError).toBe(true);
            expect(text(result)).toContain("no authenticator with that id");
        }

        expect(fake.sent).toEqual([]);
    });

    it("lists the credentials as base64url without private keys", async () => {
        const { runtime } = await withAuthenticator(managedConfig, [
            {
                credentialId        : "ab+/cd==",
                isResidentCredential: true,
                rpId                : "example.com",
                privateKey          : "SECRET-KEY",
                userHandle          : "AQID+/8=",
                signCount           : 3,
                userName            : "ada",
                backupEligibility   : true,
                backupState         : false,
            },
        ]);
        const result = await call(runtime, { action: "list_credentials", authenticatorId: "auth-1" });

        expect(result.structuredContent).toMatchObject({
            credentials: [
                {
                    credentialId      : "ab-_cd",
                    rpId              : "example.com",
                    userHandle        : "AQID-_8",
                    signCount         : 3,
                    residentCredential: true,
                    userName          : "ada",
                    backupEligible    : true,
                    backedUp          : false,
                },
            ],
        });
        expect(text(result)).not.toContain("SECRET-KEY");
        expect(text(result)).not.toContain("privateKey");
    });

    it("rejects an answer it does not understand", async () => {
        const { fake, runtime } = await withAuthenticator();

        fake.respond = () => ({ credentials: "none" });

        const result = await call(runtime, { action: "list_credentials", authenticatorId: "auth-1" });

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("unexpected answer");
    });

    it("adds a credential with its ids turned into the base64 the browser expects", async () => {
        const { fake, runtime } = await withAuthenticator();

        await call(runtime, {
            action         : "add_credential",
            authenticatorId: "auth-1",
            credentialId   : "ab-_cd",
            rpId           : "example.com",
            privateKey     : "MIGHAgEAMBMGByqGSM49",
            userHandle     : "AQID-_8",
            userName       : "ada",
        });

        expect(fake.sent[0]).toMatchObject({
            method: "WebAuthn.addCredential",
            params: {
                authenticatorId: "auth-1",
                credential     : {
                    credentialId        : "ab+/cd==",
                    isResidentCredential: true,
                    rpId                : "example.com",
                    privateKey          : "MIGHAgEAMBMGByqGSM49",
                    userHandle          : "AQID+/8=",
                    signCount           : 0,
                    userName            : "ada",
                },
            },
        });
    });

    it.each([
        [{ credentialId: "not base64!" }],
        [{ privateKey: "$$$" }],
        [{ userHandle: "a b" }],
    ])("refuses text that is not base64 in %j", async (bad) => {
        const { fake, runtime } = await withAuthenticator();
        const result = await call(runtime, {
            action         : "add_credential",
            authenticatorId: "auth-1",
            credentialId   : "abcd",
            rpId           : "example.com",
            privateKey     : "MIGH",
            ...bad,
        });

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("base64");
        expect(fake.sent).toEqual([]);
    });

    it("removes and clears credentials and sets the user verification", async () => {
        const { fake, runtime } = await withAuthenticator();

        await call(runtime, { action: "remove_credential", authenticatorId: "auth-1", credentialId: "ab-_cd" });
        await call(runtime, { action: "clear_credentials", authenticatorId: "auth-1" });
        await call(runtime, { action: "set_user_verified", authenticatorId: "auth-1", userVerified: false });

        expect(fake.sent.map((entry) => [entry.method, entry.params])).toEqual([
            ["WebAuthn.removeCredential", { authenticatorId: "auth-1", credentialId: "ab+/cd==" }],
            ["WebAuthn.clearCredentials", { authenticatorId: "auth-1" }],
            ["WebAuthn.setUserVerified", { authenticatorId: "auth-1", isUserVerified: false }],
        ]);
    });

    it("forgets the authenticators when the tab is forgotten", async () => {
        const { runtime } = await withAuthenticator();

        await runtime.forgetTab("tab1");

        expect(runtime.webauthn.ids("tab1")).toEqual([]);
    });
});

describe("webauthn input schema", () => {
    const accepts = (value: unknown) => webauthn.input.safeParse(value).success;

    it("needs the fields of the action and refuses the fields of other actions", () => {
        expect(accepts({ action: "add_authenticator" })).toBe(true);
        expect(accepts({ action: "list_authenticators" })).toBe(true);
        expect(accepts({ action: "remove_authenticator" })).toBe(false);
        expect(accepts({ action: "remove_authenticator", authenticatorId: "a" })).toBe(true);
        expect(accepts({ action: "set_user_verified", authenticatorId: "a" })).toBe(false);
        expect(accepts({ action: "set_user_verified", authenticatorId: "a", userVerified: true })).toBe(true);
        expect(accepts({ action: "add_credential", authenticatorId: "a", credentialId: "b" })).toBe(false);
        expect(
            accepts({
                action         : "add_credential",
                authenticatorId: "a",
                credentialId   : "b",
                rpId           : "example.com",
                privateKey     : "c",
            }),
        ).toBe(true);
        expect(accepts({ action: "add_authenticator", credentialId: "b" })).toBe(false);
        expect(accepts({ action: "list_credentials", authenticatorId: "a", bringToFront: true })).toBe(false);
        expect(accepts({ action: "nope" })).toBe(false);
        expect(accepts({})).toBe(false);
    });
});

describe("webauthn and the safety options", () => {
    const readOnly: Config = {
        ...managedConfig,
        safety: { ...managedConfig.safety, readOnly: true },
    };

    it("refuses what changes the tab in read-only mode and still lists", async () => {
        const { fake, runtime } = setup(readOnly);
        const refused = await call(runtime, { action: "add_authenticator" });

        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain("read-only mode");
        expect(browserCalls(fake)).toEqual([]);

        const listed = await call(runtime, { action: "list_authenticators" });

        expect(listed.isError).not.toBe(true);
    });

    it("refuses a tab outside allowedDomains", async () => {
        const restricted: Config = {
            ...managedConfig,
            safety: { ...managedConfig.safety, allowedDomains: ["other.example"] },
        };
        const { fake, runtime } = setup(restricted);
        const result = await call(runtime, { action: "add_authenticator" });

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("a.example");
        expect(browserCalls(fake)).toEqual([]);
    });
});
