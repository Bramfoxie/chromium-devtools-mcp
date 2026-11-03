import { z } from "zod";
import { IpcCancelledError } from "../../daemon/index.js";
import type { DaemonAccess } from "../../mcp/index.js";

const EMULATION_READ_TIMEOUT_MS = 5000;

export const DEVICE_READ_EXPRESSION = `(() => ({
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  devicePixelRatio: window.devicePixelRatio,
  userAgent: navigator.userAgent,
  maxTouchPoints: navigator.maxTouchPoints,
}))()`;

const deviceReadSchema = z.strictObject({
    result: z.strictObject({
        type : z.string().optional(),
        value: z.strictObject({
            innerWidth      : z.number(),
            innerHeight     : z.number(),
            devicePixelRatio: z.number(),
            userAgent       : z.string(),
            maxTouchPoints  : z.number(),
        }).optional(),
    }),
});

export interface DeviceRead {
    innerWidth      : number;
    innerHeight     : number;
    devicePixelRatio: number;
    userAgent       : string;
    maxTouchPoints  : number;
}

export const MEDIA_READ_EXPRESSION = `(() => ({
  colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark"
    : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "no-preference",
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "no-preference",
  contrast: matchMedia("(prefers-contrast: more)").matches ? "more"
    : matchMedia("(prefers-contrast: less)").matches ? "less" : "no-preference",
  forcedColors: matchMedia("(forced-colors: active)").matches ? "active" : "none",
  mediaPrint: matchMedia("print").matches,
}))()`;

const mediaReadSchema = z.strictObject({
    result: z.strictObject({
        type : z.string().optional(),
        value: z.strictObject({
            colorScheme  : z.string(),
            reducedMotion: z.string(),
            contrast     : z.string(),
            forcedColors : z.string(),
            mediaPrint   : z.boolean(),
        }).optional(),
    }),
});

interface MediaRead {
    colorScheme  : string;
    reducedMotion: string;
    contrast     : string;
    forcedColors : string;
    mediaPrint   : boolean;
}

export const LOCALE_READ_EXPRESSION = `(() => ({
  language: navigator.language,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  formatted: new Date("2026-06-01T12:00:00Z").toLocaleString(),
}))()`;

const localeReadSchema = z.strictObject({
    result: z.strictObject({
        type : z.string().optional(),
        value: z.strictObject({
            language : z.string(),
            timezone : z.string().optional(),
            formatted: z.string(),
        }).optional(),
    }),
});

interface LocaleRead {
    language : string;
    timezone?: string | undefined;
    formatted: string;
}

async function readValue<T>(
    access    : DaemonAccess,
    targetId  : string,
    expression: string,
    schema    : z.ZodType<{ result: { type?: string; value?: T } }>,
    signal?   : AbortSignal,
): Promise<T | undefined> {
    try {
        const parsed = schema.safeParse(
            await access.send({
                targetId,
                method   : "Runtime.evaluate",
                params   : { expression, returnByValue: true },
                timeoutMs: EMULATION_READ_TIMEOUT_MS,
                ...signal === undefined ? undefined : { signal },
            }),
        );

        if (!parsed.success || parsed.data.result.type === "undefined") return undefined;

        return parsed.data.result.value;
    } catch (error) {
        if (error instanceof IpcCancelledError || signal?.aborted === true) throw error;

        return undefined;
    }
}

export async function readDevice(
    access  : DaemonAccess,
    targetId: string,
    signal? : AbortSignal,
): Promise<DeviceRead | undefined> {
    return readValue(access, targetId, DEVICE_READ_EXPRESSION, deviceReadSchema, signal);
}

export async function readMedia(
    access  : DaemonAccess,
    targetId: string,
    signal? : AbortSignal,
): Promise<MediaRead | undefined> {
    return readValue(access, targetId, MEDIA_READ_EXPRESSION, mediaReadSchema, signal);
}

export async function readLocale(
    access  : DaemonAccess,
    targetId: string,
    signal? : AbortSignal,
): Promise<LocaleRead | undefined> {
    return readValue(access, targetId, LOCALE_READ_EXPRESSION, localeReadSchema, signal);
}
