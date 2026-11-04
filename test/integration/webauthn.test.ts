import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromeAvailable, html, startEnv, type Env } from "./browser-env.js";

const present = chromeAvailable();
let env: Env;
let strict: Env;

const b64url = (bytes: Uint8Array): string =>
    Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const CREATE = (verification = "preferred") => `new Promise((resolve) => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1800);
  const encode = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  navigator.credentials.create({ signal: ac.signal, publicKey: {
    challenge: new Uint8Array(32), rp: { name: "Test", id: "localhost" },
    user: { id: new Uint8Array([1, 2, 3, 4]), name: "ada", displayName: "Ada" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { residentKey: "required", userVerification: ${JSON.stringify(verification)} } } })
    .then((c) => resolve({ ok: true, id: c.id }), (e) => resolve({ ok: false, error: e.name + ": " + e.message }));
})`;

const GET = (allow: string[] = []) => `new Promise((resolve) => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1800);
  const decode = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  navigator.credentials.get({ signal: ac.signal, publicKey: {
    challenge: new Uint8Array(32), rpId: "localhost", userVerification: "preferred",
    allowCredentials: ${JSON.stringify(allow)}.map((id) => ({ type: "public-key", id: decode(id) })) } })
    .then((c) => resolve({ ok: true, id: c.id, hasUserHandle: c.response.userHandle !== null }),
          (e) => resolve({ ok: false, error: e.name + ": " + e.message }));
})`;

beforeAll(async () => {
    if (!present) return;

    env = await startEnv(undefined, true);
    strict = await startEnv();

    for (const target of [env, strict]) {
        target.other.pages.set("/wa", html("<p>webauthn</p>"));
    }
});

afterAll(async () => {
    await env?.stop();
    await strict?.stop();
});

async function open(target: Env): Promise<string> {
    const created = await target.ok("new_tab", { url: `${target.other.origin}/wa` });

    return String((created.tab as { tab: string }).tab);
}

async function page(
    target    : Env,
    tab       : string,
    expression: string,
): Promise<Record<string, unknown>> {
    const result = (await target.ok("js_evaluate", { tab, expression, awaitPromise: true })) as {
        value?: Record<string, unknown>;
    };

    return result.value ?? {};
}

type Credentials = {
    authenticatorId: string;
    credentials    : Array<{
        credentialId      : string;
        rpId              : string;
        userHandle?       : string;
        residentCredential: boolean;
        signCount         : number;
        privateKey?       : unknown;
    }>;
};

describe.skipIf(!present)("webauthn in a real browser", () => {
    it("registers and signs in with a virtual authenticator and lists the credential without its key", async () => {
        const tab = await open(env);
        const added = await env.ok("webauthn", { tab, action: "add_authenticator", bringToFront: true });
        const authenticatorId = String(added.authenticatorId);

        expect(authenticatorId.length).toBeGreaterThan(10);
        expect((await env.ok("webauthn", { tab, action: "list_authenticators" })).authenticators).toEqual([
            authenticatorId,
        ]);

        const created = await page(env, tab, CREATE());

        expect(created.ok).toBe(true);

        const listed = (await env.ok("webauthn", {
            tab,
            action: "list_credentials",
            authenticatorId,
        })) as unknown as Credentials;

        expect(listed.credentials).toHaveLength(1);
        expect(listed.credentials[0]).toMatchObject({
            credentialId      : created.id,
            rpId              : "localhost",
            residentCredential: true,
            userHandle        : "AQIDBA",
        });
        expect(JSON.stringify(listed)).not.toContain("privateKey");

        const signedIn = await page(env, tab, GET());

        expect(signedIn).toMatchObject({ ok: true, id: created.id, hasUserHandle: true });

        const after = (await env.ok("webauthn", {
            tab,
            action: "list_credentials",
            authenticatorId,
        })) as unknown as Credentials;

        expect(after.credentials[0]?.signCount).toBeGreaterThan(0);
    });

    it("adds a credential with a given key, removes it and clears the rest", async () => {
        const tab = await open(env);
        const { authenticatorId } = (await env.ok("webauthn", {
            tab,
            action      : "add_authenticator",
            bringToFront: true,
        })) as { authenticatorId: string };
        const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
        const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
        const credentialId = b64url(randomBytes(16));

        await env.ok("webauthn", {
            tab,
            action    : "add_credential",
            authenticatorId,
            credentialId,
            rpId      : "localhost",
            privateKey,
            userHandle: b64url(Buffer.from("user-1")),
            userName  : "grace",
        });

        const listed = (await env.ok("webauthn", {
            tab,
            action: "list_credentials",
            authenticatorId,
        })) as unknown as Credentials;

        expect(listed.credentials.map((entry) => entry.credentialId)).toEqual([credentialId]);
        expect(await page(env, tab, GET([credentialId]))).toMatchObject({
            ok: true,
            id: credentialId,
        });

        await env.ok("webauthn", { tab, action: "remove_credential", authenticatorId, credentialId });
        expect((await page(env, tab, GET([credentialId]))).ok).toBe(false);

        await page(env, tab, CREATE());
        await env.ok("webauthn", { tab, action: "clear_credentials", authenticatorId });

        const emptied = (await env.ok("webauthn", {
            tab,
            action: "list_credentials",
            authenticatorId,
        })) as unknown as Credentials;

        expect(emptied.credentials).toEqual([]);
    });

    it("fails the verification while the user is not verified and passes it again after", async () => {
        const tab = await open(env);
        const { authenticatorId } = (await env.ok("webauthn", {
            tab,
            action      : "add_authenticator",
            bringToFront: true,
            userVerified: false,
        })) as { authenticatorId: string };

        expect((await page(env, tab, CREATE("required"))).ok).toBe(false);

        await env.ok("webauthn", { tab, action: "set_user_verified", authenticatorId, userVerified: true });

        expect((await page(env, tab, CREATE("required"))).ok).toBe(true);
    });

    it("removes the authenticator so the page cannot use it any more", async () => {
        const tab = await open(env);
        const { authenticatorId } = (await env.ok("webauthn", {
            tab,
            action      : "add_authenticator",
            bringToFront: true,
            userVerified: false,
        })) as { authenticatorId: string };

        expect(String((await page(env, tab, CREATE("required"))).error)).toContain("NotAllowedError");

        await env.ok("webauthn", { tab, action: "remove_authenticator", authenticatorId });

        expect((await env.ok("webauthn", { tab, action: "list_authenticators" })).authenticators).toEqual([]);
        expect((await page(env, tab, CREATE("required"))).ok).toBe(false);

        const gone = await env.call("webauthn", { tab, action: "list_credentials", authenticatorId });

        expect(gone.isError).toBe(true);
        expect(gone.text).toContain("no authenticator with that id");
    });

    it("explains the focus a page needs and refuses to bring the tab to the front without allowFocus", async () => {
        await open(strict);

        const tab = await open(strict);
        const refused = await strict.call("webauthn", {
            tab,
            action      : "add_authenticator",
            bringToFront: true,
        });

        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("allowFocus");

        await strict.ok("webauthn", { tab, action: "add_authenticator" });

        const background = await page(strict, tab, CREATE());

        expect(background.ok).toBe(false);
        expect(String(background.error)).toContain("does not have focus");
    });
});
