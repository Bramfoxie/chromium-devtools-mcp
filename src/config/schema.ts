import { z } from "zod";

export const browsers = ["chrome"] as const;
export const modes = ["attach", "managed"] as const;

export const configSchema = z.strictObject({
  browser   : z.enum(browsers),
  mode      : z.enum(modes),
  headless  : z.boolean(),
  profileDir: z.string().min(1),
  debugPort : z.number().int().min(1).max(65535),
  allowFocus: z.boolean(),
  safety    : z.strictObject({
    readOnly        : z.boolean(),
    allowedDomains  : z.array(z.string().min(1)),
    confirmDangerous: z.boolean(),
  }),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
