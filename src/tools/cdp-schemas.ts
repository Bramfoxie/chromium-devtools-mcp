import { z } from "zod";

export const documentSchema = z.object({ root: z.object({ nodeId: z.number() }) });

export const nodeIdSchema = z.object({ nodeId: z.number() });

export const resolvedSchema = z.object({ object: z.object({ objectId: z.string().optional() }) });

export const quadSchema = z
    .array(z.number())
    .length(8)
    .refine((quad) => quad.every((value) => Number.isFinite(value)));

export const stackTraceSchema = z
    .object({
        callFrames: z.array(
            z.object({
                functionName: z.string(),
                url         : z.string(),
                lineNumber  : z.number(),
                columnNumber: z.number(),
            }),
        ),
    })
    .optional();
