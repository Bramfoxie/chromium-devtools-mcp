import { z } from "zod";

const DOMAIN_METHOD = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/;

const targetId = z.string().min(1).max(128);
const frameId = z.string().min(1).max(128);
const domainName = z.string().regex(DOMAIN_METHOD).max(100);

export const requestParamSchemas = {
    "daemon.status": z.strictObject({}),
    "session.open" : z.strictObject({
        isolated: z.boolean().optional(),
        safety  : z.strictObject({
            readOnly        : z.boolean(),
            allowedDomains  : z.array(z.string().min(1).max(300)).max(500),
            confirmDangerous: z.boolean(),
        }).optional(),
    }),
    "session.list": z.strictObject({}),
    "tab.create"  : z.strictObject({ url: z.string().min(1).max(2048).optional() }),
    "tab.list"    : z.strictObject({ scope: z.enum(["owned", "available"]).optional() }),
    "tab.claim"   : z.strictObject({ targetId }),
    "tab.close"   : z.strictObject({ targetId }),
    "frame.list"  : z.strictObject({ targetId }),
    "cdp.send"    : z.strictObject({
        targetId,
        method   : domainName,
        params   : z.record(z.string(), z.unknown()).optional(),
        timeoutMs: z.number().int().min(1).max(300_000).optional(),
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
