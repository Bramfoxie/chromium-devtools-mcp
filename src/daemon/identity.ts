import { z } from "zod";
import type { Config } from "../config/index.js";

export const identitySchema = z.strictObject({
    browser   : z.string(),
    mode      : z.string(),
    debugPort : z.number(),
    wsEndpoint: z.string().optional(),
    allowFocus: z.boolean(),
    headless  : z.boolean().optional(),
    profileDir: z.string().optional(),
    cdpLog    : z.string().optional(),
});

export type DaemonIdentity = z.infer<typeof identitySchema>;

const FIELDS = [
    "browser",
    "mode",
    "debugPort",
    "wsEndpoint",
    "allowFocus",
    "headless",
    "profileDir",
    "cdpLog",
] as const;

export type IdentityField = (typeof FIELDS)[number];

// Settings two clients must share; managed-only fields are omitted in attach mode.
export function daemonIdentity(
    config: Pick<
        Config,
        "browser" | "mode" | "debugPort" | "wsEndpoint" | "allowFocus" | "headless" | "profileDir" | "cdpLog"
    >,
): DaemonIdentity {
    const shared = {
        browser   : config.browser,
        mode      : config.mode,
        debugPort : config.debugPort,
        allowFocus: config.allowFocus,
        ...(config.cdpLog === undefined ? {} : { cdpLog: config.cdpLog }),
    };

    if (config.mode === "managed") {
        return { ...shared, headless: config.headless, profileDir: config.profileDir };
    }

    return config.wsEndpoint === undefined ? shared : { ...shared, wsEndpoint: config.wsEndpoint };
}

export function differingFields(a: DaemonIdentity, b: DaemonIdentity): IdentityField[] {
    return FIELDS.filter((field) => a[field] !== b[field]);
}

export function describeIdentity(
    identity: DaemonIdentity,
    fields  : readonly IdentityField[] = FIELDS,
): string {
    return fields.map((field) => {
        const value = identity[field];

        return `${field} ${field === "wsEndpoint" && value !== undefined ? "(set)" : String(value ?? "unset")}`;
    }).join(", ");
}

export function describeSettings(identity: DaemonIdentity): string {
    return describeIdentity(
        identity,
        FIELDS.filter((field) => identity[field] !== undefined),
    );
}
