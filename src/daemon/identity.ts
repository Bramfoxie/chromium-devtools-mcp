import { z } from "zod";
import type { Config } from "../config/index.js";

export const identitySchema = z.strictObject({
    browser   : z.string(),
    mode      : z.string(),
    debugPort : z.number(),
    allowFocus: z.boolean(),
    headless  : z.boolean().optional(),
    profileDir: z.string().optional(),
});

export type DaemonIdentity = z.infer<typeof identitySchema>;

const FIELDS = ["browser", "mode", "debugPort", "allowFocus", "headless", "profileDir"] as const;

export type IdentityField = (typeof FIELDS)[number];

// Settings two clients must share; managed-only fields are omitted in attach mode.
export function daemonIdentity(
    config: Pick<Config, "browser" | "mode" | "debugPort" | "allowFocus" | "headless" | "profileDir">,
): DaemonIdentity {
    const shared = {
        browser   : config.browser,
        mode      : config.mode,
        debugPort : config.debugPort,
        allowFocus: config.allowFocus,
    };

    return config.mode === "managed"
        ? { ...shared, headless: config.headless, profileDir: config.profileDir }
        : shared;
}

export function differingFields(a: DaemonIdentity, b: DaemonIdentity): IdentityField[] {
    return FIELDS.filter((field) => a[field] !== b[field]);
}

export function describeIdentity(
    identity: DaemonIdentity,
    fields  : readonly IdentityField[] = FIELDS,
): string {
    return fields.map((field) => `${field} ${String(identity[field] ?? "unset")}`).join(", ");
}
