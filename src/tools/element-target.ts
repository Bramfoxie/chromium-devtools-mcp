import { z } from "zod";
import { ErrorCode, RpcError } from "../daemon/index.js";
import type { DaemonAccess } from "../mcp/index.js";
import { ToolError } from "./errors.js";
import type { FrameState } from "./frames.js";

export const MAX_SELECTOR_LENGTH = 1024;

export const MAX_UIDS_PER_TAB = 5000;

export const STALE_UID_MESSAGE =
    "This element id is stale. Take a new dom_snapshot or run dom_query again.";

export const PIERCE_CHAIN_SEPARATOR = ">>>";

export const PIERCE_CHAIN_MAX_SEGMENTS = 10;

export const MAX_FRAME_LENGTH = 1024;

export const elementTargetSchema = z
    .strictObject({
        uid     : z.string().min(1).max(64).optional(),
        selector: z.string().min(1).max(MAX_SELECTOR_LENGTH).optional(),
        pierce  : z.boolean().optional(),
        frame   : z.string().min(1).max(MAX_FRAME_LENGTH).optional(),
    })
    .superRefine((value, ctx) => {
        if ((value.uid !== undefined) === (value.selector !== undefined)) {
            ctx.addIssue({
                code   : "custom",
                message: "Provide exactly one of uid or selector, not both and not neither.",
            });
        }

        if (value.uid !== undefined && (value.pierce !== undefined || value.frame !== undefined)) {
            ctx.addIssue({
                code   : "custom",
                message: "pierce and frame only combine with selector, not with uid.",
            });
        }
    });

export type ElementTarget = z.infer<typeof elementTargetSchema>;

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

export interface ElementNode {
    backendNodeId   : number;
    frameId?        : string;
    frameGeneration?: number;
}

export interface ResolvedElement extends ElementNode {
    objectId: string;
}

export type ElementRef = { nodeId: number } | { backendNodeId: number } | { objectId: string };

export interface Rect {
    x     : number;
    y     : number;
    width : number;
    height: number;
}

export interface ElementBox {
    box    : Rect | null;
    visible: boolean;
}

const UID_PATTERN = /^(\d+)_(\d+)$/;

interface TabElements {
    generation: number;
    counter   : number;
    uids      : Map<string, ElementNode>;
    byNode    : Map<string, string>;
}

function nodeKeyOf(node: ElementNode | undefined): string {
    if (node === undefined) return "";

    return `${node.backendNodeId}|${node.frameId ?? ""}`;
}

export class ElementRegistry {
    private readonly tabs = new Map<string, TabElements>();

    generation(tab: string): number {
        return this.state(tab).generation;
    }

    nextGeneration(tab: string): number {
        const state = this.state(tab);

        state.generation += 1;
        state.counter = 0;
        state.uids.clear();
        state.byNode.clear();

        return state.generation;
    }

    assign(tab: string, nodes: ElementNode[]): Array<string | undefined> {
        const state = this.state(tab);

        return nodes.map((node) => {
            // The same element keeps its uid: repeated queries do not burn
            // through the per-tab budget.
            const key = `${node.backendNodeId}|${node.frameId ?? ""}`;
            const known = state.byNode.get(key);

            if (known !== undefined && state.uids.has(known)) return known;

            if (state.uids.size >= MAX_UIDS_PER_TAB) {
                const oldest = state.uids.keys().next();

                if (oldest.done === true) return undefined;

                state.byNode.delete(nodeKeyOf(state.uids.get(oldest.value)));
                state.uids.delete(oldest.value);
            }

            state.counter += 1;
            const uid = `${state.generation}_${state.counter}`;

            state.uids.set(uid, { ...node });
            state.byNode.set(key, uid);

            return uid;
        });
    }

    lookup(
        tab             : string,
        uid             : string,
        frameGeneration?: (frameId: string) => number,
    ): ElementNode | undefined {
        const state = this.tabs.get(tab);
        const generation = state === undefined ? undefined : UID_PATTERN.exec(uid)?.[1];

        if (state === undefined || generation === undefined) return undefined;
        if (Number(generation) !== state.generation) return undefined;

        const found = state.uids.get(uid);

        if (found === undefined) return undefined;

        if (
            found.frameId !== undefined && found.frameGeneration !== undefined &&
            frameGeneration !== undefined &&
            frameGeneration(found.frameId) !== found.frameGeneration
        ) {
            return undefined;
        }

        return { ...found };
    }

    invalidateFrame(tab: string, frameId: string): void {
        const state = this.tabs.get(tab);

        if (state === undefined) return;

        for (const [uid, node] of state.uids) {
            if (node.frameId === frameId) {
                state.byNode.delete(nodeKeyOf(node));
                state.uids.delete(uid);
            }
        }
    }

    forget(tab: string): void {
        this.tabs.delete(tab);
    }

    reset(): void {
        this.tabs.clear();
    }

    private state(tab: string): TabElements {
        let state = this.tabs.get(tab);

        if (!state) {
            state = { generation: 0, counter: 0, uids: new Map(), byNode: new Map() };
            this.tabs.set(tab, state);
        }

        return state;
    }
}

const documentSchema = z.object({ root: z.object({ nodeId: z.number() }) });
const nodeIdSchema = z.object({ nodeId: z.number() });
const resolvedSchema = z.object({ object: z.object({ objectId: z.string().optional() }) });
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
const quadSchema = z
    .array(z.number())
    .length(8)
    .refine((quad) => quad.every((value) => Number.isFinite(value)));
const boxModelSchema = z.object({
    model: z.object({
        content: quadSchema,
        padding: quadSchema,
        border : quadSchema,
        margin : quadSchema,
    }),
});

function parseCdp<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);

    if (parsed.success) return parsed.data;

    throw new ToolError(`The browser sent an unexpected response to ${method}. Try the call again.`);
}

function isCdpError(error: unknown): boolean {
    return error instanceof RpcError && error.code === ErrorCode.cdpError;
}

export function rectOfQuad(quad: number[]): Rect {
    const xs = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
    const ys = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0];
    const left = Math.min(...xs);
    const top = Math.min(...ys);

    return {
        x     : Math.round(left),
        y     : Math.round(top),
        width : Math.round(Math.max(...xs) - left),
        height: Math.round(Math.max(...ys) - top),
    };
}

export interface ResolverFrames {
    resolve(tab: string, frame: string): Promise<{ frameId: string }>;
    generation(tab: string, frameId: string): number;
}

function framesOf(frames: FrameState | undefined): ResolverFrames | undefined {
    return frames;
}

async function resolveByUid(
    access: DaemonAccess,
    tab   : string,
    node  : ElementNode,
): Promise<string> {
    let result: unknown;

    try {
        result = await access.send(tab, "DOM.resolveNode", { backendNodeId: node.backendNodeId });
    } catch (error) {
        if (isCdpError(error)) throw new ToolError(STALE_UID_MESSAGE);

        throw error;
    }

    const objectId = parseCdp("DOM.resolveNode", resolvedSchema, result).object.objectId;

    if (objectId === undefined) throw new ToolError(STALE_UID_MESSAGE);

    return objectId;
}

async function queryOne(
    access  : DaemonAccess,
    tab     : string,
    nodeId  : number,
    selector: string,
): Promise<number> {
    let found: unknown;

    try {
        found = await access.send(tab, "DOM.querySelector", { nodeId, selector });
    } catch (error) {
        if (error instanceof RpcError && error.code === ErrorCode.cdpError) {
            throw new ToolError(`The selector ${JSON.stringify(selector)} is invalid: ${error.message}`);
        }

        throw error;
    }

    return parseCdp("DOM.querySelector", nodeIdSchema, found).nodeId;
}

async function resolveNodeId(
    access  : DaemonAccess,
    tab     : string,
    nodeId  : number,
    selector: string,
): Promise<{ objectId: string; backendNodeId: number }> {
    let resolved: unknown;

    try {
        resolved = await access.send(tab, "DOM.resolveNode", { nodeId });
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
        await access.send(tab, "DOM.describeNode", { nodeId, depth: 0 }),
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
): Promise<{ nodeId: number; frameId: string | undefined }> {
    if (frame === undefined) return { nodeId: rootId, frameId: undefined };

    if (frames !== undefined) {
        try {
            const resolved = await frames.resolve(tab, frame);
            const scope = await frameContentNode(access, tab, rootId, resolved.frameId);

            if (scope === undefined) {
                throw new ToolError(
                    `The frame ${JSON.stringify(frame)} has no document yet. Wait for it to load and try again.`,
                );
            }

            return { nodeId: scope, frameId: resolved.frameId };
        } catch (error) {
            // Unknown frame ids fall through to the iframe selector path.
            if (error instanceof ToolError && !error.message.startsWith("No frame ")) throw error;
        }
    }

    const owner = await queryOne(access, tab, rootId, frame);

    if (owner === 0) {
        throw new ToolError(
            `No frame matches ${JSON.stringify(frame)}. Pass a frame id from dom_snapshot or an iframe selector.`,
        );
    }

    const described = parseCdp(
        "DOM.describeNode",
        describedNodeSchema,
        await access.send(tab, "DOM.describeNode", { nodeId: owner, depth: 1, pierce: true }),
    );

    if (described.node.nodeName !== "IFRAME" && described.node.nodeName !== "FRAME") {
        const tag = (described.node.nodeName ?? "unknown").toLowerCase();

        throw new ToolError(
            `The frame selector ${JSON.stringify(frame)} matched <${tag}>, not an iframe. Target an iframe element or pass a frame id from dom_snapshot.`,
        );
    }

    const content = described.node.contentDocument;

    if (content === undefined) {
        throw new ToolError(
            `The frame ${JSON.stringify(frame)} has no document yet. Wait for it to load and try again.`,
        );
    }

    return { nodeId: content.nodeId, frameId: described.node.frameId };
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
        await access.send(tab, "DOM.getDocument", { depth: -1, pierce: true }),
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
            await access.send(tab, "DOM.describeNode", { nodeId: found, depth: 1, pierce: true }),
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
    await access.send(tab, "DOM.enable", {});
    await access.send(tab, "DOM.getDocument", { depth: -1, pierce: true });

    const search = parseCdp(
        "DOM.performSearch",
        searchSchema,
        await access.send(tab, "DOM.performSearch", {
            query                    : selector,
            includeUserAgentShadowDOM: true,
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
            await access.send(tab, "DOM.getSearchResults", {
                searchId : search.searchId,
                fromIndex: 0,
                toIndex  : 1,
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
        await access.send(tab, "DOM.discardSearchResults", { searchId: search.searchId }).catch(
            () => undefined,
        );
    }
}

async function resolveBySelector(
    access  : DaemonAccess,
    tab     : string,
    selector: string,
    options : { pierce?: boolean; frame?: string },
    frames  : ResolverFrames | undefined,
): Promise<{ objectId: string; backendNodeId: number; frameId?: string }> {
    const document = parseCdp(
        "DOM.getDocument",
        documentSchema,
        await access.send(tab, "DOM.getDocument", { depth: 0, pierce: false }),
    );
    const scope = await scopeNode(access, tab, document.root.nodeId, options.frame, frames);
    const chained = splitPierceChain(selector) !== undefined;

    if (chained && options.pierce === true) {
        throw new ToolError("Pass pierce or a >>> chain, not both: they are two ways to cross shadow roots.");
    }

    const nodeId = options.pierce === true
        ? await resolvePierced(access, tab, selector)
        : chained
            ? await resolveChain(access, tab, scope.nodeId, selector)
            : await resolvePlain(access, tab, scope.nodeId, selector);
    const resolved = await resolveNodeId(access, tab, nodeId, selector);

    return { ...resolved, ...(scope.frameId === undefined ? {} : { frameId: scope.frameId }) };
}

export interface ResolveElementOptions {
    frames?: FrameState;
}

export async function resolveElement(
    access  : DaemonAccess,
    elements: ElementRegistry,
    tab     : string,
    target  : ElementTarget,
    options : ResolveElementOptions = {},
): Promise<ResolvedElement> {
    const frames = framesOf(options.frames);

    if (target.uid !== undefined) {
        const node = elements.lookup(
            tab,
            target.uid,
            frames === undefined ? undefined : (frameId) => frames.generation(tab, frameId),
        );

        if (node === undefined) throw new ToolError(STALE_UID_MESSAGE);

        return { ...node, objectId: await resolveByUid(access, tab, node) };
    }

    if (target.selector === undefined) {
        throw new ToolError("Provide exactly one of uid or selector, not both and not neither.");
    }

    const resolved = await resolveBySelector(
        access,
        tab,
        target.selector,
        { pierce: target.pierce, frame: target.frame },
        frames,
    );

    return {
        backendNodeId: resolved.backendNodeId,
        objectId     : resolved.objectId,
        ...(resolved.frameId === undefined ? {} : { frameId: resolved.frameId }),
    };
}

export async function boxOf(
    access: DaemonAccess,
    tab   : string,
    ref   : ElementRef,
): Promise<ElementBox> {
    let result: unknown;

    try {
        result = await access.send(tab, "DOM.getBoxModel", { ...ref });
    } catch (error) {
        // A hidden element has no box model, so its CDP error means invisible.
        if (isCdpError(error)) return { box: null, visible: false };

        throw error;
    }

    const box = rectOfQuad(parseCdp("DOM.getBoxModel", boxModelSchema, result).model.content);

    return { box, visible: box.width > 0 && box.height > 0 };
}

export async function revealElement(
    access: DaemonAccess,
    tab   : string,
    ref   : ElementRef,
): Promise<ElementBox> {
    try {
        await access.send(tab, "DOM.scrollIntoViewIfNeeded", { ...ref });
    } catch (error) {
        if (isCdpError(error)) {
            throw new ToolError("The element is not visible on the page and cannot be scrolled into view.");
        }

        throw error;
    }

    return boxOf(access, tab, ref);
}
