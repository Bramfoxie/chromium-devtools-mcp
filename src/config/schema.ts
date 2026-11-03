import { z } from "zod";
import { DOMAIN_RULE_FORMS, isValidDomainRule } from "../safety/index.js";
import { AppError } from "../util/app-error.js";

export const browsers = ["chrome"] as const;

export const modes = ["attach", "managed"] as const;

export const configSchema = z.strictObject({
    browser   : z.enum(browsers),
    mode      : z.enum(modes),
    headless  : z.boolean(),
    profileDir: z.string().min(1),
    debugPort : z.number().int().min(0).max(65535),
    allowFocus: z.boolean(),
    isolated  : z.boolean(),
    safety    : z.strictObject({
        readOnly      : z.boolean(),
        allowedDomains: z.array(
            z.string().refine(isValidDomainRule, {
                error: (issue) =>
                    `invalid entry ${JSON.stringify(issue.input)}, accepted forms: ${DOMAIN_RULE_FORMS}`,
            }),
        ),
        confirmDangerous: z.boolean(),
    }),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends AppError {}
