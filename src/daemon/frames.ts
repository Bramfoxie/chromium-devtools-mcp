import { z } from "zod";

export interface FrameSummary {
    frameId      : string;
    parentFrameId: string | undefined;
    url          : string;
    name         : string;
    isolated     : boolean;
}

interface FrameNode {
    frame      : { id: string; parentId?: string; url?: string; name?: string };
    childFrames: FrameNode[];
}

const frameNodeSchema: z.ZodType<FrameNode> = z.object({
    frame: z.object({
        id      : z.string().min(1),
        parentId: z.string().optional(),
        url     : z.string().optional(),
        name    : z.string().optional(),
    }),
    childFrames: z.array(z.lazy(() => frameNodeSchema)).optional().default([]),
});

const frameTreeSchema = z.object({ frameTree: frameNodeSchema });

export function frameSummaries(
    tree    : unknown,
    isolated: (frameId: string) => boolean,
): FrameSummary[] {
    const parsed = frameTreeSchema.safeParse(tree);

    if (!parsed.success) return [];

    const summaries: FrameSummary[] = [];
    const visit = (node: FrameNode): void => {
        summaries.push({
            frameId      : node.frame.id,
            parentFrameId: node.frame.parentId,
            url          : node.frame.url ?? "",
            name         : node.frame.name ?? "",
            isolated     : isolated(node.frame.id),
        });

        for (const child of node.childFrames) visit(child);
    };

    visit(parsed.data.frameTree);

    return summaries;
}
