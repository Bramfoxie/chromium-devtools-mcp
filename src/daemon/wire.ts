import { z } from "zod";
import { isValidDomainRule } from "../safety/index.js";

const DOMAIN_METHOD = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/;

const MAX_ID_CHARS = 128;
const MAX_METHOD_NAME_CHARS = 100;
const MAX_DOMAIN_RULE_CHARS = 300;
const MAX_DOMAIN_RULES = 500;
const MAX_URL_CHARS = 2048;
const MAX_CDP_TIMEOUT_MS = 300_000;

const targetId = z.string().min(1).max(MAX_ID_CHARS);
const frameId = z.string().min(1).max(MAX_ID_CHARS);
const domainName = z.string().regex(DOMAIN_METHOD).max(MAX_METHOD_NAME_CHARS);

export const requestParamSchemas = {
    "daemon.status": z.strictObject({}),
    "daemon.stop"  : z.strictObject({}),
    "session.open" : z.strictObject({
        isolated: z.boolean().optional(),
        safety  : z.strictObject({
            readOnly      : z.boolean(),
            allowedDomains: z.array(
                z.string().min(1).max(MAX_DOMAIN_RULE_CHARS).refine(isValidDomainRule),
            ).max(MAX_DOMAIN_RULES),
            deniedDomains: z.array(
                z.string().min(1).max(MAX_DOMAIN_RULE_CHARS).refine(isValidDomainRule),
            ).max(MAX_DOMAIN_RULES),
            allowPrivateNetworks: z.boolean(),
            confirmDangerous    : z.boolean(),
            uploadDirs          : z.array(z.string().min(1).max(1024)).max(50),
        }).optional(),
    }),
    "session.list"  : z.strictObject({}),
    "permission.set": z.strictObject({
        name     : z.enum(["geolocation", "notifications", "camera", "microphone", "clipboard-read", "clipboard-write"]),
        setting  : z.enum(["granted", "denied", "reset"]),
        origin   : z.string().min(1).max(MAX_URL_CHARS),
        owner    : z.enum(["geolocation", "permissions"]).optional(),
        confirmed: z.boolean().optional(),
    }),
    "tab.create": z.strictObject({ url: z.string().min(1).max(MAX_URL_CHARS).optional() }),
    "tab.list"  : z.strictObject({ scope: z.enum(["owned", "available"]).optional() }),
    "popup.list": z.strictObject({ targetId }),
    "window.get": z.strictObject({ targetId }),
    "tab.claim" : z.strictObject({ targetId }),
    "tab.close" : z.strictObject({ targetId }),
    "frame.list": z.strictObject({ targetId }),
    "cdp.send"  : z.strictObject({
        targetId,
        method   : domainName,
        params   : z.record(z.string(), z.unknown()).optional(),
        timeoutMs: z.number().int().min(1).max(MAX_CDP_TIMEOUT_MS).optional(),
        frameId  : frameId.optional(),
        confirmed: z.boolean().optional(),
    }),
    "cdp.subscribe"  : z.strictObject({ targetId, event: domainName, frameId: frameId.optional() }),
    "cdp.unsubscribe": z.strictObject({ targetId, event: domainName, frameId: frameId.optional() }),
} as const;

export const tabSchema = z.strictObject({
    targetId: z.string(),
    url     : z.string(),
    title   : z.string(),
    owned   : z.boolean(),
    created : z.boolean(),
});

export type TabInfo = z.infer<typeof tabSchema>;

export const tabListSchema = z.strictObject({ tabs: z.array(tabSchema) });

export const createdSchema = z.strictObject({ targetId: z.string() });

export const frameSchema = z.strictObject({
    frameId      : z.string(),
    parentFrameId: z.string().optional(),
    url          : z.string(),
    name         : z.string(),
    isolated     : z.boolean(),
    truncated    : z.boolean().optional(),
});

export type FrameSummary = z.infer<typeof frameSchema>;

export const frameListSchema = z.strictObject({ frames: z.array(frameSchema) });

export const sessionSummarySchema = z.strictObject({
    sessionId : z.string(),
    clientName: z.string(),
    isolated  : z.boolean(),
    tabs      : z.number(),
    own       : z.boolean(),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionListSchema = z.strictObject({ sessions: z.array(sessionSummarySchema) });
