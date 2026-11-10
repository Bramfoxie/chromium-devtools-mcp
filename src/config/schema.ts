import { z } from "zod";
import { DOMAIN_RULE_FORMS, isValidDomainRule } from "../safety/index.js";
import { AppError } from "../util/app-error.js";
import { isValidWsEndpoint, WS_ENDPOINT_FORM } from "./ws-endpoint.js";

export const browsers = [
    "chrome",
    "chrome-beta",
    "chrome-dev",
    "chrome-canary",
    "chromium",
    "edge",
] as const;

export const modes = ["attach", "managed"] as const;

export const configSchema = z.strictObject({
    browser   : z.enum(browsers),
    mode      : z.enum(modes),
    headless  : z.boolean(),
    profileDir: z.string().min(1),
    debugPort : z.number().int().min(0).max(65535),
    wsEndpoint: z
        .string()
        .refine(isValidWsEndpoint, {
            error: () => `invalid endpoint, accepted form: ${WS_ENDPOINT_FORM}`,
        })
        .optional(),
    allowFocus  : z.boolean(),
    isolated    : z.boolean(),
    tools       : z.array(z.string().min(1).max(64)).max(100).optional(),
    excludeTools: z.array(z.string().min(1).max(64)).max(100).optional(),
    auditLog    : z.string().min(1).max(1024).optional(),
    safety      : z.strictObject({
        readOnly      : z.boolean(),
        allowedDomains: z.array(
            z.string().refine(isValidDomainRule, {
                error: (issue) =>
                    `invalid entry ${JSON.stringify(issue.input)}, accepted forms: ${DOMAIN_RULE_FORMS}`,
            }),
        ),
        deniedDomains: z.array(
            z.string().refine(isValidDomainRule, {
                error: (issue) =>
                    `invalid entry ${JSON.stringify(issue.input)}, accepted forms: ${DOMAIN_RULE_FORMS}`,
            }),
        ),
        allowPrivateNetworks: z.boolean(),
        confirmDangerous    : z.boolean(),
    }),
}).refine((config) => config.wsEndpoint === undefined || config.mode === "attach", {
    path   : ["wsEndpoint"],
    message: "is used only in attach mode, remove it or set mode to attach",
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends AppError {}
