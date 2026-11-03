import { z } from "zod";
import { ErrorCode, RpcError } from "../daemon/index.js";
import type { DaemonAccess } from "../mcp/index.js";
import { documentSchema, nodeIdSchema, resolvedSchema } from "./cdp-schemas.js";
import { isCdpError, parseCdp } from "./cdp-parse.js";
import { ToolError } from "./errors.js";
import { bindAccess, isolatedDocumentNode } from "./frame-scope.js";

export const MAX_FRAME_LENGTH = 1024;

const PIERCE_CHAIN_SEPARATOR = ">>>";

const PIERCE_CHAIN_MAX_SEGMENTS = 10;

export function splitPierceChain(selector: string): string[] | undefined {
    if (!selector.includes(PIERCE_CHAIN_SEPARATOR)) return undefined;

    const segments = selector.split(PIERCE_CHAIN_SEPARATOR).map((segment) => segment.trim());

    if (segments.some((segment) => segment === "")) {
        throw new ToolError(
            `The selector chain ${JSON.stringify(selector)} has an empty segment. Every part around " >>> " must be a CSS selector.`,
        );
    }

    if (segments.length > PIERCE_CHAIN_MAX_SEGMENTS) {
        throw new ToolError(
            `The selector chain has ${segments.length} segments, over the limit of ${PIERCE_CHAIN_MAX_SEGMENTS}. Shorten the chain.`,
        );
    }

    return segments;
}

const describedNodeSchema = z.object({
    node: z.object({
        nodeName       : z.string().optional(),
        backendNodeId  : z.number().optional(),
        frameId        : z.string().optional(),
        contentDocument: z.object({ nodeId: z.number() }).passthrough().optional(),
        shadowRoots    : z.array(z.object({ nodeId: z.number() }).passthrough()).optional(),
    }).passthrough(),
});
const searchSchema = z.object({ searchId: z.string(), resultCount: z.number() });
const searchResultsSchema = z.object({ nodeIds: z.array(z.number()) });

export interface ResolverFrames {
    resolve(tab: string, frame: string): Promise<{ frameId: string; isolated?: boolean }>;
    refresh?(tab: string): Promise<unknown>;
    generation(tab: string, frameId: string): number;
}

async function queryOne(
    access  : DaemonAccess,
    tab     : string,
    nodeId  : number,
    selector: string,
): Promise<number> {
    let found: unknown;

    try {
        found = await access.send({
            targetId: tab,
            method  : "DOM.querySelector",
            params  : { nodeId, selector },
        });
    } catch (error) {
        if (error instanceof RpcError && error.code === ErrorCode.cdpError) {
            throw new ToolError(`The selector ${JSON.stringify(selector)} is invalid: ${error.message}`);
        }

        throw error;
    }

    return parseCdp("DOM.querySelector", nodeIdSchema, found).nodeId;
}

const nodeIdsSchema = z.object({ nodeIds: z.array(z.number()) });

const candidateSchema = z.object({
    node: z.object({
        nodeName       : z.string().optional(),
        attributes     : z.array(z.string()).optional(),
        frameId        : z.string().optional(),
        contentDocument: z.object({ documentURL: z.string().optional() }).passthrough().optional(),
    }).passthrough(),
});

const MAX_FRAME_CANDIDATES = 10;

async function queryAll(
    access  : DaemonAccess,
    tab     : string,
    nodeId  : number,
    selector: string,
): Promise<number[]> {
    let found: unknown;

    try {
        found = await access.send({
            targetId: tab,
            method  : "DOM.querySelectorAll",
            params  : { nodeId, selector },
        });
    } catch (error) {
        if (error instanceof RpcError && error.code === ErrorCode.cdpError) {
            throw new ToolError(`The selector ${JSON.stringify(selector)} is invalid: ${error.message}`);
        }

        throw error;
    }

    return parseCdp("DOM.querySelectorAll", nodeIdsSchema, found).nodeIds;
}

function attributeOf(flat: string[], name: string): string {
    for (let i = 0; i + 1 < flat.length; i += 2) {
        if (flat[i] === name) return flat[i + 1] ?? "";
    }

    return "";
}

export async function ambiguousFrameError(
    access : DaemonAccess,
    tab    : string,
    frame  : string,
    nodeIds: number[],
): Promise<ToolError> {
    const lines: string[] = [];

    for (const [index, nodeId] of nodeIds.slice(0, MAX_FRAME_CANDIDATES).entries()) {
        const parsed = candidateSchema.safeParse(
            await access.send({
                targetId: tab,
                method  : "DOM.describeNode",
                params  : { nodeId, depth: 1, pierce: true },
            }),
        );

        if (!parsed.success) continue;

        const flat = parsed.data.node.attributes ?? [];
        const url = parsed.data.node.contentDocument?.documentURL ?? attributeOf(flat, "src");
        const frameId = parsed.data.node.frameId;

        lines.push(
            `  ${index}: <${(parsed.data.node.nodeName ?? "unknown").toLowerCase()}> id=${JSON.stringify(attributeOf(flat, "id"))} name=${JSON.stringify(attributeOf(flat, "name"))} url=${JSON.stringify(url)}${frameId === undefined ? "" : ` frame=${frameId}`}`,
        );
    }

    const more = nodeIds.length > MAX_FRAME_CANDIDATES
        ? `\n  and ${nodeIds.length - MAX_FRAME_CANDIDATES} more`
        : "";

    return new ToolError(
        `The frame selector ${JSON.stringify(frame)} matches ${nodeIds.length} iframes:\n${lines.join("\n")}${more}\nPass the frame id from dom_snapshot or narrow the selector to match one iframe.`,
    );
}

async function resolveNodeId(
    access  : DaemonAccess,
    tab     : string,
    nodeId  : number,
    selector: string,
): Promise<{ objectId: string; backendNodeId: number }> {
    let resolved: unknown;

    try {
        resolved = await access.send({
            targetId: tab,
            method  : "DOM.resolveNode",
            params  : { nodeId },
        });
    } catch (error) {
        if (isCdpError(error)) {
            throw new ToolError(
                `The element matched by ${JSON.stringify(selector)} is gone from the page. Run the call again.`,
            );
        }

        throw error;
    }

    const objectId = parseCdp("DOM.resolveNode", resolvedSchema, resolved).object.objectId;

    if (objectId === undefined) {
        throw new ToolError(
            `The element matched by ${JSON.stringify(selector)} is gone from the page. Run the call again.`,
        );
    }

    const described = parseCdp(
        "DOM.describeNode",
        describedNodeSchema,
        await access.send({
            targetId: tab,
            method  : "DOM.describeNode",
            params  : { nodeId, depth: 0 },
        }),
    );
    const backendNodeId = described.node.backendNodeId;

    if (backendNodeId === undefined) {
        throw new ToolError(
            "The browser sent an unexpected response to DOM.describeNode. Try the call again.",
        );
    }

    return { objectId, backendNodeId };
}

async function scopeNode(
    access: DaemonAccess,
    tab   : string,
    rootId: number,
    frame : string | undefined,
    frames: ResolverFrames | undefined,
): Promise<{ nodeId: number; frameId: string | undefined; access?: DaemonAccess }> {
    if (frame === undefined) return { nodeId: rootId, frameId: undefined };

    if (frames !== undefined) {
        try {
            const resolved = await frames.resolve(tab, frame);

            if (resolved.isolated === true) {
                return isolatedScope(access, tab, frame, resolved.frameId);
            }

            const scope = await frameContentNode(access, tab, rootId, resolved.frameId);

            if (scope === undefined) {
                throw new ToolError(
                    `The frame ${JSON.stringify(frame)} has no document yet. Wait for it to load and try again.`,
                );
            }

            return { nodeId: scope, frameId: resolved.frameId };
        } catch (error) {
            if (error instanceof ToolError && !error.message.startsWith("No frame ")) throw error;
        }
    }

    const owners = await queryAll(access, tab, rootId, frame);
    const owner = owners[0];

    if (owner === undefined) {
        throw new ToolError(
            `No frame matches ${JSON.stringify(frame)}. Pass a frame id from dom_snapshot or an iframe selector.`,
        );
    }

    if (owners.length > 1) throw await ambiguousFrameError(access, tab, frame, owners);

    const described = parseCdp(
        "DOM.describeNode",
        describedNodeSchema,
        await access.send({
            targetId: tab,
            method  : "DOM.describeNode",
            params  : { nodeId: owner, depth: 1, pierce: true },
        }),
    );

    if (described.node.nodeName !== "IFRAME" && described.node.nodeName !== "FRAME") {
        const tag = (described.node.nodeName ?? "unknown").toLowerCase();

        throw new ToolError(
            `The frame selector ${JSON.stringify(frame)} matched <${tag}>, not an iframe. Target an iframe element or pass a frame id from dom_snapshot.`,
        );
    }

    const content = described.node.contentDocument;

    if (content === undefined) {
        const remote = await isolatedOwner(frames, tab, described.node.frameId);

        if (remote !== undefined) return isolatedScope(access, tab, frame, remote);

        throw new ToolError(
            `The frame ${JSON.stringify(frame)} has no document yet. Wait for it to load and try again.`,
        );
    }

    return { nodeId: content.nodeId, frameId: described.node.frameId };
}

async function isolatedOwner(
    frames : ResolverFrames | undefined,
    tab    : string,
    frameId: string | undefined,
): Promise<string | undefined> {
    if (frames === undefined || frameId === undefined) return undefined;

    await frames.refresh?.(tab).catch(() => undefined);
    const info = await frames.resolve(tab, frameId).catch(() => undefined);

    return info?.isolated === true ? info.frameId : undefined;
}

async function isolatedScope(
    access : DaemonAccess,
    tab    : string,
    frame  : string,
    frameId: string,
): Promise<{ nodeId: number; frameId: string; access: DaemonAccess }> {
    const bound = bindAccess(access, frameId);
    const nodeId = await isolatedDocumentNode(bound, tab, frameId);

    if (nodeId === undefined) {
        throw new ToolError(
            `The frame ${JSON.stringify(frame)} has no document yet. Wait for it to load and try again.`,
        );
    }

    return { nodeId, frameId, access: bound };
}

async function frameContentNode(
    access : DaemonAccess,
    tab    : string,
    rootId : number,
    frameId: string,
): Promise<number | undefined> {
    const document = parseCdp(
        "DOM.getDocument",
        piercedDocumentSchema,
        await access.send({
            targetId: tab,
            method  : "DOM.getDocument",
            params  : { depth: -1, pierce: true },
        }),
    );

    return findFrameContent(document.root, rootId, frameId);
}

interface PiercedNode {
    nodeId          : number;
    nodeName        : string;
    frameId?        : string | undefined;
    children        : PiercedNode[];
    shadowRoots     : PiercedNode[];
    contentDocument?: PiercedNode | undefined;
}

const piercedNodeSchema: z.ZodType<PiercedNode> = z.object({
    nodeId         : z.number(),
    nodeName       : z.string(),
    frameId        : z.string().optional(),
    children       : z.array(z.lazy(() => piercedNodeSchema)).optional().default([]),
    shadowRoots    : z.array(z.lazy(() => piercedNodeSchema)).optional().default([]),
    contentDocument: z.lazy(() => piercedNodeSchema).optional(),
});

const piercedDocumentSchema = z.object({ root: piercedNodeSchema });

function findFrameContent(root: PiercedNode, rootId: number, frameId: string): number | undefined {
    if (root.nodeId === rootId && frameId === "") return root.nodeId;

    const visit = (node: PiercedNode): number | undefined => {
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

    return visit(root);
}

async function resolvePlain(
    access  : DaemonAccess,
    tab     : string,
    scope   : number,
    selector: string,
): Promise<number> {
    const nodeId = await queryOne(access, tab, scope, selector);

    if (nodeId === 0) {
        throw new ToolError(
            `No element matches the selector ${JSON.stringify(selector)}. Check the selector and try again.`,
        );
    }

    return nodeId;
}

async function resolveChain(
    access  : DaemonAccess,
    tab     : string,
    scope   : number,
    selector: string,
): Promise<number> {
    const segments = splitPierceChain(selector) ?? [selector];
    let nodeId = scope;

    for (const [index, segment] of segments.entries()) {
        const found = await queryOne(access, tab, nodeId, segment);

        if (found === 0) {
            throw new ToolError(
                `No element matches the selector ${JSON.stringify(selector)} at segment ${JSON.stringify(segment)}. Check the selector and try again.`,
            );
        }

        if (index === segments.length - 1) return found;

        const described = parseCdp(
            "DOM.describeNode",
            describedNodeSchema,
            await access.send({
                targetId: tab,
                method  : "DOM.describeNode",
                params  : { nodeId: found, depth: 1, pierce: true },
            }),
        );
        const root = described.node.shadowRoots?.[0];

        if (root === undefined) {
            throw new ToolError(
                `The element matched by ${JSON.stringify(segment)} has no shadow root to pierce. Check the selector and try again.`,
            );
        }

        nodeId = root.nodeId;
    }

    throw new ToolError(
        `No element matches the selector ${JSON.stringify(selector)}. Check the selector and try again.`,
    );
}

async function resolvePierced(
    access  : DaemonAccess,
    tab     : string,
    selector: string,
): Promise<number> {
    await access.send({
        targetId: tab,
        method  : "DOM.enable",
        params  : {},
    });
    await access.send({
        targetId: tab,
        method  : "DOM.getDocument",
        params  : { depth: -1, pierce: true },
    });

    const search = parseCdp(
        "DOM.performSearch",
        searchSchema,
        await access.send({
            targetId: tab,
            method  : "DOM.performSearch",
            params  : {
                query                    : selector,
                includeUserAgentShadowDOM: true,
            },
        }),
    );

    try {
        if (search.resultCount === 0) {
            throw new ToolError(
                `No element matches the selector ${JSON.stringify(selector)}. Check the selector and try again.`,
            );
        }

        const results = parseCdp(
            "DOM.getSearchResults",
            searchResultsSchema,
            await access.send({
                targetId: tab,
                method  : "DOM.getSearchResults",
                params  : {
                    searchId : search.searchId,
                    fromIndex: 0,
                    toIndex  : 1,
                },
            }),
        );
        const nodeId = results.nodeIds[0];

        if (nodeId === undefined || nodeId === 0) {
            throw new ToolError(
                `No element matches the selector ${JSON.stringify(selector)}. Check the selector and try again.`,
            );
        }

        return nodeId;
    } finally {
        await access.send({
            targetId: tab,
            method  : "DOM.discardSearchResults",
            params  : { searchId: search.searchId },
        }).catch(
            () => undefined,
        );
    }
}

export async function resolveBySelector(
    access  : DaemonAccess,
    tab     : string,
    selector: string,
    options : { pierce?: boolean; frame?: string },
    frames  : ResolverFrames | undefined,
): Promise<{ objectId: string; backendNodeId: number; frameId?: string; isolated?: boolean }> {
    const document = parseCdp(
        "DOM.getDocument",
        documentSchema,
        await access.send({
            targetId: tab,
            method  : "DOM.getDocument",
            params  : { depth: 0, pierce: false },
        }),
    );
    const scope = await scopeNode(access, tab, document.root.nodeId, options.frame, frames);
    const chained = splitPierceChain(selector) !== undefined;

    if (chained && options.pierce === true) {
        throw new ToolError("Pass pierce or a >>> chain, not both: they are two ways to cross shadow roots.");
    }

    const scoped = scope.access ?? access;
    const nodeId = options.pierce === true
        ? await resolvePierced(scoped, tab, selector)
        : chained
            ? await resolveChain(scoped, tab, scope.nodeId, selector)
            : await resolvePlain(scoped, tab, scope.nodeId, selector);
    const resolved = await resolveNodeId(scoped, tab, nodeId, selector);

    return {
        ...resolved,
        ...(scope.frameId === undefined ? {} : { frameId: scope.frameId }),
        ...(scope.access === undefined ? {} : { isolated: true }),
    };
}
