import { z } from "zod";
import { defineTool, type ToolContext } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { ToolError } from "./errors.js";
import { throwIfCancelled } from "./registry.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const ACTIONS = [
    "add_authenticator",
    "remove_authenticator",
    "list_authenticators",
    "list_credentials",
    "add_credential",
    "remove_credential",
    "clear_credentials",
    "set_user_verified",
] as const;

type Action = (typeof ACTIONS)[number];

const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

const FIELDS: Record<Action, readonly string[]> = {
    add_authenticator   : ["protocol", "transport", "residentKey", "userVerification", "userVerified", "automaticPresence", "bringToFront"],
    remove_authenticator: ["authenticatorId"],
    list_authenticators : [],
    list_credentials    : ["authenticatorId"],
    add_credential      : ["authenticatorId", "credentialId", "rpId", "privateKey", "userHandle", "signCount", "residentCredential", "userName", "userDisplayName"],
    remove_credential   : ["authenticatorId", "credentialId"],
    clear_credentials   : ["authenticatorId"],
    set_user_verified   : ["authenticatorId", "userVerified"],
};

const REQUIRED: Record<Action, readonly string[]> = {
    add_authenticator   : [],
    remove_authenticator: ["authenticatorId"],
    list_authenticators : [],
    list_credentials    : ["authenticatorId"],
    add_credential      : ["authenticatorId", "credentialId", "rpId", "privateKey"],
    remove_credential   : ["authenticatorId", "credentialId"],
    clear_credentials   : ["authenticatorId"],
    set_user_verified   : ["authenticatorId", "userVerified"],
};

const OPTION_FIELDS = [...new Set(Object.values(FIELDS).flat())];

const credentialSchema = z.object({
    credentialId        : z.string(),
    isResidentCredential: z.boolean(),
    rpId                : z.string().optional(),
    userHandle          : z.string().optional(),
    signCount           : z.number(),
    userName            : z.string().optional(),
    userDisplayName     : z.string().optional(),
    backupEligibility   : z.boolean().optional(),
    backupState         : z.boolean().optional(),
});

function standardBase64(value: string, name: string): string {
    if (!BASE64.test(value) || value === "") {
        throw new ToolError(`${name} must be base64 or base64url text.`);
    }

    const standard = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");

    return standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), "=");
}

function urlSafe(value: string): string {
    return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const webauthn = defineTool({
    name       : "webauthn",
    closedWorld: true,
    description:
        "Test passkey and security key sign-in on a tab with a virtual authenticator: add one, let the page register and sign in, and list, add, remove or clear its credentials. Chrome lets a page use WebAuthn only on the tab that has the focus of the browser, and a tab in the background fails with 'The page does not have focus', so pass bringToFront with add_authenticator (it needs allowFocus) or call bring_to_front first. The private keys are never returned.",
    access: (args: unknown) => {
        const action = (args as { action?: unknown } | null)?.action;

        return action === "list_authenticators" || action === "list_credentials" ? "read" : "mutate";
    },
    input: z.strictObject({
        tab               : tabSchema,
        action            : z.enum(ACTIONS).describe("What to do."),
        authenticatorId   : z.string().min(1).max(128).optional().describe("The authenticator, from add_authenticator or list_authenticators."),
        protocol          : z.enum(["ctap2", "u2f"]).optional().describe("add_authenticator: ctap2 supports passkeys, u2f is the older security key. Defaults to ctap2."),
        transport         : z.enum(["internal", "usb", "nfc", "ble"]).optional().describe("add_authenticator: internal is a platform authenticator such as Touch ID, the others are security keys. Defaults to internal for ctap2 and usb for u2f."),
        residentKey       : z.boolean().optional().describe("add_authenticator: whether it stores discoverable credentials, which passkeys need. Defaults to true for ctap2; u2f cannot."),
        userVerification  : z.boolean().optional().describe("add_authenticator: whether it can verify the user, for example by PIN or fingerprint. Defaults to true for ctap2; u2f cannot."),
        userVerified      : z.boolean().optional().describe("add_authenticator and set_user_verified: whether the user passes the verification. Defaults to true."),
        automaticPresence : z.boolean().optional().describe("add_authenticator: answer every touch prompt at once, as there is no one to touch the key. Defaults to true."),
        bringToFront      : z.boolean().optional().describe("add_authenticator: bring the tab to the front first, because WebAuthn needs its focus. Needs allowFocus. Defaults to false."),
        credentialId      : z.string().min(1).max(1024).optional().describe("add_credential and remove_credential: the credential id as base64url, as in PublicKeyCredential.id."),
        rpId              : z.string().min(1).max(253).optional().describe("add_credential: the relying party id, the domain of the site, such as example.com."),
        privateKey        : z.string().min(1).max(4096).optional().describe("add_credential: the private key as base64 of PKCS#8, an ECDSA P-256 key for the usual ES256 passkey."),
        userHandle        : z.string().min(1).max(512).optional().describe("add_credential: the user handle as base64url."),
        signCount         : z.number().int().min(0).max(4_294_967_295).optional().describe("add_credential: the signature counter. Defaults to 0."),
        residentCredential: z.boolean().optional().describe("add_credential: whether it is a discoverable credential. Defaults to true."),
        userName          : z.string().max(256).optional().describe("add_credential: the user name shown with the passkey."),
        userDisplayName   : z.string().max(256).optional().describe("add_credential: the display name shown with the passkey."),
    }).superRefine((value, ctx) => {
        const record = value as Record<string, unknown>;
        const given = OPTION_FIELDS.filter((field) => record[field] !== undefined);

        for (const field of given) {
            if (!FIELDS[value.action].includes(field)) {
                ctx.addIssue({ code: "custom", message: `${field} does not apply to ${value.action}.` });
            }
        }

        for (const field of REQUIRED[value.action]) {
            if (!given.includes(field)) {
                ctx.addIssue({ code: "custom", message: `${value.action} needs ${field}.` });
            }
        }
    }),
    output: z.strictObject({
        tab            : z.string().describe("Tab id."),
        action         : z.enum(ACTIONS),
        authenticatorId: z.string().optional().describe("The authenticator that was added or acted on."),
        authenticators : z.array(z.string()).optional().describe("The authenticators of the tab."),
        credentials    : z.array(z.strictObject({
            credentialId      : z.string().describe("Credential id as base64url."),
            rpId              : z.string().optional(),
            userHandle        : z.string().optional().describe("User handle as base64url."),
            signCount         : z.number(),
            residentCredential: z.boolean(),
            userName          : z.string().optional(),
            userDisplayName   : z.string().optional(),
            backupEligible    : z.boolean().optional(),
            backedUp          : z.boolean().optional(),
        })).optional().describe("The credentials of the authenticator, without private keys."),
        effect: z.string().describe("Short summary of what happened."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        throwIfCancelled(context.signal);
        await ensureNoDialog(context.dialogs, targetId);

        const base = { tab: targetId, action: args.action };

        if (args.action === "list_authenticators") {
            const ids = context.webauthn.ids(targetId);

            return { ...base, authenticators: ids, effect: `${ids.length} authenticator${ids.length === 1 ? "" : "s"}.` };
        }

        if (args.action === "add_authenticator") return addAuthenticator(args, context, targetId, base);

        const authenticatorId = args.authenticatorId ?? "";

        if (!context.webauthn.has(targetId, authenticatorId)) {
            throw new ToolError(
                "This tab has no authenticator with that id. List them with action list_authenticators, or add one with add_authenticator.",
            );
        }

        const send = (method: string, params: Record<string, unknown>) =>
            context.access.send({ targetId, method, params });

        switch (args.action) {
            case "remove_authenticator": {
                await send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });

                if (context.webauthn.remove(targetId, authenticatorId) === 0) {
                    await send("WebAuthn.disable", {});
                }

                return { ...base, authenticatorId, effect: "The authenticator was removed." };
            }

            case "list_credentials": {
                const parsed = z
                    .object({ credentials: z.array(credentialSchema) })
                    .safeParse(await send("WebAuthn.getCredentials", { authenticatorId }));

                if (!parsed.success) {
                    throw new ToolError("The browser sent an unexpected answer to WebAuthn.getCredentials. Try again.");
                }

                return {
                    ...base,
                    authenticatorId,
                    credentials: parsed.data.credentials.map((entry) => ({
                        credentialId: urlSafe(entry.credentialId),
                        ...(entry.rpId === undefined ? {} : { rpId: entry.rpId }),
                        ...(entry.userHandle === undefined
                            ? {}
                            : { userHandle: urlSafe(entry.userHandle) }),
                        signCount         : entry.signCount,
                        residentCredential: entry.isResidentCredential,
                        ...(entry.userName === undefined ? {} : { userName: entry.userName }),
                        ...(entry.userDisplayName === undefined
                            ? {}
                            : { userDisplayName: entry.userDisplayName }),
                        ...(entry.backupEligibility === undefined
                            ? {}
                            : { backupEligible: entry.backupEligibility }),
                        ...(entry.backupState === undefined ? {} : { backedUp: entry.backupState }),
                    })),
                    effect: `${parsed.data.credentials.length} credential${parsed.data.credentials.length === 1 ? "" : "s"}.`,
                };
            }

            case "add_credential": {
                await send("WebAuthn.addCredential", {
                    authenticatorId,
                    credential: {
                        credentialId        : standardBase64(args.credentialId ?? "", "credentialId"),
                        isResidentCredential: args.residentCredential ?? true,
                        rpId                : args.rpId,
                        privateKey          : standardBase64(args.privateKey ?? "", "privateKey"),
                        ...(args.userHandle === undefined
                            ? {}
                            : { userHandle: standardBase64(args.userHandle, "userHandle") }),
                        signCount: args.signCount ?? 0,
                        ...(args.userName === undefined ? {} : { userName: args.userName }),
                        ...(args.userDisplayName === undefined
                            ? {}
                            : { userDisplayName: args.userDisplayName }),
                    },
                });

                return { ...base, authenticatorId, effect: "The credential was added." };
            }

            case "remove_credential": {
                await send("WebAuthn.removeCredential", {
                    authenticatorId,
                    credentialId: standardBase64(args.credentialId ?? "", "credentialId"),
                });

                return { ...base, authenticatorId, effect: "The credential was removed." };
            }

            case "clear_credentials": {
                await send("WebAuthn.clearCredentials", { authenticatorId });

                return { ...base, authenticatorId, effect: "All credentials were removed." };
            }

            case "set_user_verified": {
                const verified = args.userVerified ?? true;

                await send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: verified });

                return {
                    ...base,
                    authenticatorId,
                    effect: verified ? "The user now passes verification." : "The user now fails verification.",
                };
            }
        }
    },
});

async function addAuthenticator(
    args   : {
        protocol?         : "ctap2" | "u2f" | undefined;
        transport?        : "internal" | "usb" | "nfc" | "ble" | undefined;
        residentKey?      : boolean | undefined;
        userVerification? : boolean | undefined;
        userVerified?     : boolean | undefined;
        automaticPresence?: boolean | undefined;
        bringToFront?     : boolean | undefined;
    },
    context: ToolContext,
    tab    : string,
    base   : { tab: string; action: Action },
) {
    const protocol = args.protocol ?? "ctap2";
    const transport = args.transport ?? (protocol === "u2f" ? "usb" : "internal");

    if (protocol === "u2f" && (transport === "internal" || args.residentKey === true || args.userVerification === true)) {
        throw new ToolError(
            "A u2f authenticator is a security key: it cannot be internal and cannot store discoverable credentials or verify the user. Use protocol ctap2 for passkeys.",
        );
    }

    if (args.bringToFront === true && !context.config.allowFocus) {
        throw new ToolError(
            "Bringing the tab to the front is turned off. Ask the owner to enable allowFocus in the config, then call the tool again.",
        );
    }

    if (args.bringToFront === true) {
        await context.access.send({ targetId: tab, method: "Page.bringToFront", params: {} });
    }

    const first = context.webauthn.ids(tab).length === 0;

    if (first) {
        await context.access.send({ targetId: tab, method: "WebAuthn.enable", params: { enableUI: false } });
    }

    const modern = protocol === "ctap2";
    const options = {
        protocol,
        ...(modern ? { ctap2Version: "ctap2_1" } : {}),
        transport,
        hasResidentKey             : modern ? (args.residentKey ?? true) : false,
        hasUserVerification        : modern ? (args.userVerification ?? true) : false,
        isUserVerified             : args.userVerified ?? true,
        automaticPresenceSimulation: args.automaticPresence ?? true,
    };
    let added: unknown;

    try {
        added = await context.access.send({
            targetId: tab,
            method  : "WebAuthn.addVirtualAuthenticator",
            params  : { options },
        });
    } catch (error) {
        if (first) await context.access.send({ targetId: tab, method: "WebAuthn.disable", params: {} }).catch(() => undefined);

        throw error;
    }

    const parsed = z.object({ authenticatorId: z.string().min(1) }).safeParse(added);

    if (!parsed.success) {
        throw new ToolError("The browser sent an unexpected answer to WebAuthn.addVirtualAuthenticator. Try again.");
    }

    context.webauthn.add(tab, parsed.data.authenticatorId);

    return {
        ...base,
        authenticatorId: parsed.data.authenticatorId,
        effect         : `A ${protocol} ${transport} authenticator was added${options.hasResidentKey ? " for passkeys" : ""}.`,
    };
}
