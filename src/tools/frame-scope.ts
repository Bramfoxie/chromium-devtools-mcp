import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";

interface DocumentNode {
    nodeId          : number;
    nodeName        : string;
    frameId?        : string | undefined;
    children        : DocumentNode[];
    shadowRoots     : DocumentNode[];
    contentDocument?: DocumentNode | undefined;
}

const documentNodeSchema: z.ZodType<DocumentNode> = z.object({
    nodeId         : z.number(),
    nodeName       : z.string(),
    frameId        : z.string().optional(),
    children       : z.array(z.lazy(() => documentNodeSchema)).optional().default([]),
    shadowRoots    : z.array(z.lazy(() => documentNodeSchema)).optional().default([]),
    contentDocument: z.lazy(() => documentNodeSchema).optional(),
});

const documentSchema = z.object({ root: documentNodeSchema });
const frameTreeSchema = z.object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) });

export function bindAccess(access: DaemonAccess, frameId: string): DaemonAccess {
    return new Proxy(access, {
        get(target, property) {
            if (property === "send") {
                return (
                    tab       : string,
                    method    : string,
                    params?   : Record<string, unknown>,
                    timeoutMs?: number,
                    frame?    : string,
                    options?  : { signal?: AbortSignal },
                ) => target.send(tab, method, params, timeoutMs, frame ?? frameId, options);
            }

            const value: unknown = Reflect.get(target, property, target);

            return typeof value === "function"
                ? (value as (...args: unknown[]) => unknown).bind(target)
                : value;
        },
    });
}

function findOwner(root: DocumentNode, frameId: string): DocumentNode | undefined {
    const visit = (node: DocumentNode): DocumentNode | undefined => {
        if (
            (node.nodeName === "IFRAME" || node.nodeName === "FRAME") &&
            node.frameId === frameId && node.contentDocument !== undefined
        ) {
            return node.contentDocument;
        }

        for (const next of [...node.children, ...node.shadowRoots]) {
            const found = visit(next);

            if (found !== undefined) return found;
        }

        return node.contentDocument === undefined ? undefined : visit(node.contentDocument);
    };

    return visit(root);
}

// The access must be bound to the frame so DOM nodes come from the session that owns it.
export async function isolatedDocumentNode(
    bound  : DaemonAccess,
    tab    : string,
    frameId: string,
): Promise<number | undefined> {
    const tree = frameTreeSchema.safeParse(await bound.send(tab, "Page.getFrameTree", {}));
    const document = documentSchema.safeParse(
        await bound.send(tab, "DOM.getDocument", { depth: -1, pierce: true }),
    );

    if (!document.success) return undefined;

    if (tree.success && tree.data.frameTree.frame.id === frameId) return document.data.root.nodeId;

    return findOwner(document.data.root, frameId)?.nodeId;
}
