import { z } from "zod";
import { ErrorCode, RpcError } from "../daemon/index.js";
import type { DaemonAccess } from "../mcp/index.js";
import { ToolError } from "./errors.js";

export const MAX_SELECTOR_LENGTH = 1024;

export const MAX_UIDS_PER_TAB = 5000;

export const STALE_UID_MESSAGE =
    "This element id is stale. Take a new dom_snapshot or run dom_query again.";

export const elementTargetSchema = z
    .strictObject({
        uid     : z.string().min(1).max(64).optional(),
        selector: z.string().min(1).max(MAX_SELECTOR_LENGTH).optional(),
    })
    .superRefine((value, ctx) => {
        if ((value.uid !== undefined) === (value.selector !== undefined)) {
            ctx.addIssue({
                code   : "custom",
                message: "Provide exactly one of uid or selector, not both and not neither.",
            });
        }
    });

export type ElementTarget = z.infer<typeof elementTargetSchema>;

export interface ElementNode {
    backendNodeId: number;
    frameId?     : string;
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

        return state.generation;
    }

    assign(tab: string, nodes: ElementNode[]): Array<string | undefined> {
        const state = this.state(tab);

        return nodes.map((node) => {
            if (state.uids.size >= MAX_UIDS_PER_TAB) return undefined;

            state.counter += 1;
            const uid = `${state.generation}_${state.counter}`;

            state.uids.set(uid, { ...node });

            return uid;
        });
    }

    lookup(tab: string, uid: string): ElementNode | undefined {
        const state = this.tabs.get(tab);
        const generation = state === undefined ? undefined : UID_PATTERN.exec(uid)?.[1];

        if (state === undefined || generation === undefined) return undefined;
        if (Number(generation) !== state.generation) return undefined;

        const found = state.uids.get(uid);

        return found === undefined ? undefined : { ...found };
    }

    reset(): void {
        this.tabs.clear();
    }

    private state(tab: string): TabElements {
        let state = this.tabs.get(tab);

        if (!state) {
            state = { generation: 0, counter: 0, uids: new Map() };
            this.tabs.set(tab, state);
        }

        return state;
    }
}

const documentSchema = z.object({ root: z.object({ nodeId: z.number() }) });
const nodeIdSchema = z.object({ nodeId: z.number() });
const resolvedSchema = z.object({ object: z.object({ objectId: z.string().optional() }) });
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

async function resolveBySelector(
    access  : DaemonAccess,
    tab     : string,
    selector: string,
): Promise<{ objectId: string; backendNodeId: number }> {
    const document = parseCdp(
        "DOM.getDocument",
        documentSchema,
        await access.send(tab, "DOM.getDocument", { depth: 0, pierce: false }),
    );
    let found: unknown;

    try {
        found = await access.send(tab, "DOM.querySelector", {
            nodeId: document.root.nodeId,
            selector,
        });
    } catch (error) {
        if (error instanceof RpcError && error.code === ErrorCode.cdpError) {
            throw new ToolError(`The selector ${JSON.stringify(selector)} is invalid: ${error.message}`);
        }

        throw error;
    }

    const nodeId = parseCdp("DOM.querySelector", nodeIdSchema, found).nodeId;

    if (nodeId === 0) {
        throw new ToolError(
            `No element matches the selector ${JSON.stringify(selector)}. Check the selector and try again.`,
        );
    }

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

    const described = await access.send(tab, "DOM.describeNode", { nodeId, depth: 0 });
    const backendNodeId = (described as { node?: { backendNodeId?: unknown } } | null)?.node
        ?.backendNodeId;

    if (typeof backendNodeId !== "number") {
        throw new ToolError(
            "The browser sent an unexpected response to DOM.describeNode. Try the call again.",
        );
    }

    return { objectId, backendNodeId };
}

export async function resolveElement(
    access  : DaemonAccess,
    elements: ElementRegistry,
    tab     : string,
    target  : ElementTarget,
): Promise<ResolvedElement> {
    if (target.uid !== undefined) {
        const node = elements.lookup(tab, target.uid);

        if (node === undefined) throw new ToolError(STALE_UID_MESSAGE);

        return { ...node, objectId: await resolveByUid(access, tab, node) };
    }

    if (target.selector === undefined) {
        throw new ToolError("Provide exactly one of uid or selector, not both and not neither.");
    }

    const resolved = await resolveBySelector(access, tab, target.selector);

    return { backendNodeId: resolved.backendNodeId, objectId: resolved.objectId };
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
