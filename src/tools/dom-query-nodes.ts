import { z } from "zod";
import { ErrorCode, RpcError } from "../daemon/index.js";
import type { DaemonAccess } from "../mcp/index.js";
import { nodeIdSchema } from "./cdp-schemas.js";
import type { ToolContext } from "./define-tool.js";
import { QUERY_MAX_LIMIT } from "./dom-query-rows.js";
import { ambiguousFrameError, splitPierceChain } from "./element-target.js";
import { ToolError } from "./errors.js";
import { bindAccess, isolatedDocumentNode } from "./frame-scope.js";

const nodeIdsSchema = z.object({ nodeIds: z.array(z.number()) });
const worldSchema = z.object({ executionContextId: z.number() });
const frameOwnerSchema = z.object({
    node: z.object({
        nodeName       : z.string(),
        frameId        : z.string().optional(),
        contentDocument: z.object({ nodeId: z.number() }).passthrough().optional(),
        shadowRoots    : z.array(z.object({ nodeId: z.number() }).passthrough()).optional(),
    }).passthrough(),
});
const searchSchema = z.object({ searchId: z.string(), resultCount: z.number() });
const searchResultsSchema = z.object({ nodeIds: z.array(z.number()) });

const ELEMENT_NODE = 1;
const nodeTypeSchema = z.object({ node: z.object({ nodeType: z.number() }) });

export async function matchingNodes(
    access  : DaemonAccess,
    targetId: string,
    rootId  : number,
    selector: string,
    all     : boolean,
): Promise<number[]> {
    try {
        if (!all) {
            const found = nodeIdSchema.safeParse(
                await access.send(targetId, "DOM.querySelector", { nodeId: rootId, selector }),
            );

            if (!found.success) {
                throw new ToolError(
                    "The browser sent an unexpected response to DOM.querySelector. Try the call again.",
                );
            }

            return found.data.nodeId === 0 ? [] : [found.data.nodeId];
        }

        const found = nodeIdsSchema.safeParse(
            await access.send(targetId, "DOM.querySelectorAll", { nodeId: rootId, selector }),
        );

        if (!found.success) {
            throw new ToolError(
                "The browser sent an unexpected response to DOM.querySelectorAll. Try the call again.",
            );
        }

        return found.data.nodeIds;
    } catch (error) {
        if (error instanceof RpcError && error.code === ErrorCode.cdpError) {
            throw new ToolError(
                `The selector ${JSON.stringify(selector)} is invalid: ${error.message}`,
            );
        }

        throw error;
    }
}

interface QueryScope {
    nodeId   : number;
    frameId  : string | undefined;
    contextId: number | undefined;
    access?  : DaemonAccess;
}

export async function queryScope(
    context : ToolContext,
    targetId: string,
    rootId  : number,
    frame   : string | undefined,
): Promise<QueryScope> {
    if (frame === undefined) return { nodeId: rootId, frameId: undefined, contextId: undefined };

    await context.frames.ensure(targetId).catch(() => undefined);

    const known = context.frames.frameOf(targetId, frame);

    if (known !== undefined && known.isolated) {
        return isolatedQueryScope(context, targetId, frame, known.frameId);
    }

    if (known !== undefined) {
        const world = worldSchema.safeParse(
            await context.access.send(targetId, "Page.createIsolatedWorld", {
                frameId  : known.frameId,
                worldName: "chromium-devtools-mcp-query",
            }),
        );

        if (!world.success) {
            throw new ToolError(
                "The browser sent an unexpected response to Page.createIsolatedWorld. Try the call again.",
            );
        }

        const nodeId = await frameContentNode(context.access, targetId, known.frameId);

        if (nodeId === undefined) {
            throw new ToolError(
                `The frame ${JSON.stringify(frame)} has no document yet. Wait for it to load and try again.`,
            );
        }

        return {
            nodeId,
            frameId  : known.frameId,
            contextId: world.data.executionContextId,
        };
    }

    const owner = await matchingNodes(context.access, targetId, rootId, frame, true);
    const first = owner[0];

    if (first === undefined) {
        throw new ToolError(
            `No frame matches ${JSON.stringify(frame)}. Pass a frame id from dom_snapshot or an iframe selector.`,
        );
    }

    if (owner.length > 1) {
        throw await ambiguousFrameError(context.access, targetId, frame, owner);
    }

    const described = frameOwnerSchema.safeParse(
        await context.access.send(targetId, "DOM.describeNode", {
            nodeId: first,
            depth : 1,
            pierce: true,
        }),
    );

    if (!described.success) {
        throw new ToolError(
            "The browser sent an unexpected response to DOM.describeNode. Try the call again.",
        );
    }

    if (described.data.node.nodeName !== "IFRAME" && described.data.node.nodeName !== "FRAME") {
        throw new ToolError(
            `The frame selector ${JSON.stringify(frame)} matched <${described.data.node.nodeName.toLowerCase()}>, not an iframe. Target an iframe element or pass a frame id from dom_snapshot.`,
        );
    }

    const content = described.data.node.contentDocument;

    if (content === undefined) {
        const owner = described.data.node.frameId;

        if (owner !== undefined) {
            await context.frames.refresh(targetId).catch(() => undefined);
            const remote = context.frames.frameOf(targetId, owner);

            if (remote?.isolated === true) {
                return isolatedQueryScope(context, targetId, frame, remote.frameId);
            }
        }

        throw new ToolError(
            `The frame ${JSON.stringify(frame)} has no document yet. Wait for it to load and try again.`,
        );
    }

    const frameId = described.data.node.frameId;

    if (frameId !== undefined) {
        const world = worldSchema.safeParse(
            await context.access.send(targetId, "Page.createIsolatedWorld", {
                frameId,
                worldName: "chromium-devtools-mcp-query",
            }),
        );

        if (world.success) {
            return { nodeId: content.nodeId, frameId, contextId: world.data.executionContextId };
        }
    }

    return { nodeId: content.nodeId, frameId, contextId: undefined };
}

async function isolatedQueryScope(
    context : ToolContext,
    targetId: string,
    frame   : string,
    frameId : string,
): Promise<QueryScope> {
    const bound = bindAccess(context.access, frameId);
    const world = worldSchema.safeParse(
        await bound.send(targetId, "Page.createIsolatedWorld", {
            frameId,
            worldName: "chromium-devtools-mcp-query",
        }),
    );
    const nodeId = await isolatedDocumentNode(bound, targetId, frameId);

    if (nodeId === undefined) {
        throw new ToolError(
            `The frame ${JSON.stringify(frame)} has no document yet. Wait for it to load and try again.`,
        );
    }

    return {
        nodeId,
        frameId,
        contextId: world.success ? world.data.executionContextId : undefined,
        access   : bound,
    };
}

interface PiercedDocNode {
    nodeId          : number;
    nodeName        : string;
    frameId?        : string | undefined;
    children        : PiercedDocNode[];
    shadowRoots     : PiercedDocNode[];
    contentDocument?: PiercedDocNode | undefined;
}

const piercedDocSchema: z.ZodType<PiercedDocNode> = z.object({
    nodeId         : z.number(),
    nodeName       : z.string(),
    frameId        : z.string().optional(),
    children       : z.array(z.lazy(() => piercedDocSchema)).optional().default([]),
    shadowRoots    : z.array(z.lazy(() => piercedDocSchema)).optional().default([]),
    contentDocument: z.lazy(() => piercedDocSchema).optional(),
});

async function frameContentNode(
    access  : DaemonAccess,
    targetId: string,
    frameId : string,
): Promise<number | undefined> {
    const document = z.object({ root: piercedDocSchema }).safeParse(
        await access.send(targetId, "DOM.getDocument", { depth: -1, pierce: true }),
    );

    if (!document.success) return undefined;

    const visit = (node: PiercedDocNode): number | undefined => {
        if (
            (node.nodeName === "IFRAME" || node.nodeName === "FRAME") &&
            node.frameId === frameId && node.contentDocument !== undefined
        ) {
            return node.contentDocument.nodeId;
        }

        for (const child of node.children) {
            const found = visit(child);

            if (found !== undefined) return found;
        }

        for (const shadow of node.shadowRoots) {
            const found = visit(shadow);

            if (found !== undefined) return found;
        }

        if (node.contentDocument !== undefined) {
            const found = visit(node.contentDocument);

            if (found !== undefined) return found;
        }

        return undefined;
    };

    return visit(document.data.root);
}

export async function chainedNodes(
    access  : DaemonAccess,
    targetId: string,
    scope   : number,
    selector: string,
    all     : boolean,
): Promise<number[]> {
    const segments = splitPierceChain(selector) ?? [selector];
    let current = [scope];

    for (const [index, segment] of segments.entries()) {
        const last = index === segments.length - 1;
        const next: number[] = [];

        for (const nodeId of current) {
            const found = await matchingNodes(access, targetId, nodeId, segment, last && all);

            if (last) {
                next.push(...found);

                continue;
            }

            for (const match of found) {
                const described = frameOwnerSchema.safeParse(
                    await access.send(targetId, "DOM.describeNode", {
                        nodeId: match,
                        depth : 1,
                        pierce: true,
                    }),
                );

                if (!described.success) {
                    throw new ToolError(
                        "The browser sent an unexpected response to DOM.describeNode. Try the call again.",
                    );
                }

                const root = described.data.node.shadowRoots?.[0];

                if (root !== undefined) next.push(root.nodeId);
            }
        }

        current = next;

        if (current.length === 0) return [];
    }

    return current;
}

function frameNodeIds(root: PiercedDocNode, documentId: number): Set<number> {
    const ids = new Set<number>();
    const collect = (node: PiercedDocNode): void => {
        ids.add(node.nodeId);

        for (const child of [...node.children, ...node.shadowRoots]) collect(child);
    };
    const find = (node: PiercedDocNode): boolean => {
        if (node.nodeId === documentId) {
            collect(node);

            return true;
        }

        const inner = node.contentDocument === undefined ? [] : [node.contentDocument];

        return [...node.children, ...node.shadowRoots, ...inner].some(find);
    };

    find(root);

    return ids;
}

export async function piercedNodes(
    access   : DaemonAccess,
    targetId : string,
    selector : string,
    all      : boolean,
    frameRoot: number | undefined,
): Promise<{ nodeIds: number[]; total: number }> {
    await access.send(targetId, "DOM.enable", {});

    const tree = z.object({ root: piercedDocSchema }).safeParse(
        await access.send(targetId, "DOM.getDocument", { depth: -1, pierce: true }),
    );
    const inFrame = frameRoot === undefined
        ? undefined
        : tree.success
            ? frameNodeIds(tree.data.root, frameRoot)
            : new Set<number>();

    const search = searchSchema.safeParse(
        await access.send(targetId, "DOM.performSearch", {
            query                    : selector,
            includeUserAgentShadowDOM: false,
        }),
    );

    if (!search.success) {
        throw new ToolError(
            "The browser sent an unexpected response to DOM.performSearch. Try the call again.",
        );
    }

    try {
        if (search.data.resultCount === 0) return { nodeIds: [], total: 0 };

        const toIndex = inFrame !== undefined
            ? search.data.resultCount
            : all ? Math.min(search.data.resultCount, QUERY_MAX_LIMIT) : 1;
        const results = searchResultsSchema.safeParse(
            await access.send(targetId, "DOM.getSearchResults", {
                searchId : search.data.searchId,
                fromIndex: 0,
                toIndex,
            }),
        );

        if (!results.success) {
            throw new ToolError(
                "The browser sent an unexpected response to DOM.getSearchResults. Try the call again.",
            );
        }

        const ids = results.data.nodeIds.filter(
            (nodeId) => nodeId !== 0 && (inFrame === undefined || inFrame.has(nodeId)),
        );

        const elements = await elementNodeIds(access, targetId, ids);
        const total = search.data.resultCount - (toIndex - elements.length);

        if (inFrame === undefined) return { nodeIds: elements, total };

        return { nodeIds: elements.slice(0, all ? QUERY_MAX_LIMIT : 1), total: elements.length };
    } finally {
        await access.send(targetId, "DOM.discardSearchResults", {
            searchId: search.data.searchId,
        }).catch(() => undefined);
    }
}

async function elementNodeIds(
    access  : DaemonAccess,
    targetId: string,
    nodeIds : number[],
): Promise<number[]> {
    const elements: number[] = [];

    for (const nodeId of nodeIds) {
        const parsed = nodeTypeSchema.safeParse(
            await access.send(targetId, "DOM.describeNode", { nodeId, depth: 0 }),
        );

        if (parsed.success && parsed.data.node.nodeType === ELEMENT_NODE) elements.push(nodeId);
    }

    return elements;
}
