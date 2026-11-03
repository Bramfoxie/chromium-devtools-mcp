import { z } from "zod";
import type { Config } from "../config/index.js";
import type { DaemonAccess } from "../mcp/index.js";
import { isRestricted } from "../safety/index.js";
import { ToolError } from "./errors.js";
import { bindAccess } from "./frame-scope.js";
import type { FrameState } from "./frames.js";
import { assertPageAllowed } from "./page-allowed.js";
import { quadSchema, resolvedSchema } from "./cdp-schemas.js";
import { releaseQuietly } from "./remote-objects.js";
import { isCdpError, parseCdp } from "./cdp-parse.js";
import {
    ElementRegistry,
    STALE_UID_MESSAGE,
    type ElementNode,
    type ResolvedElement,
} from "./element-registry.js";
import { MAX_FRAME_LENGTH, resolveBySelector, type ResolverFrames } from "./element-selector.js";

export { ElementRegistry, MAX_UIDS_PER_TAB, STALE_UID_MESSAGE } from "./element-registry.js";

export type { ResolvedElement } from "./element-registry.js";

export { ambiguousFrameError, MAX_FRAME_LENGTH, splitPierceChain } from "./element-selector.js";

const MAX_SELECTOR_LENGTH = 1024;

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

type ElementRef = { nodeId: number } | { backendNodeId: number } | { objectId: string };

export interface Rect {
    x     : number;
    y     : number;
    width : number;
    height: number;
}

interface ElementBox {
    box    : Rect | null;
    visible: boolean;
}

const boxModelSchema = z.object({
    model: z.object({
        content: quadSchema,
        padding: quadSchema,
        border : quadSchema,
        margin : quadSchema,
    }),
});

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

interface ResolveElementOptions {
    frames?: FrameState;
}

export function elementAccess(access: DaemonAccess, element: ElementNode): DaemonAccess {
    return element.isolated === true && element.frameId !== undefined
        ? bindAccess(access, element.frameId)
        : access;
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

        const owner = node.isolated === true && node.frameId !== undefined
            ? bindAccess(access, node.frameId)
            : access;

        return { ...node, objectId: await resolveByUid(owner, tab, node) };
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
        ...(resolved.isolated === true ? { isolated: true } : {}),
    };
}

interface ElementScope {
    config? : Config;
    access  : DaemonAccess;
    elements: ElementRegistry;
    frames  : FrameState;
}

async function assertElementDocumentAllowed(
    scope  : ElementScope,
    tab    : string,
    element: ResolvedElement,
): Promise<void> {
    if (scope.config === undefined || !isRestricted(scope.config.safety.allowedDomains)) return;

    let href: unknown;

    try {
        const reply = await elementAccess(scope.access, element).send(tab, "Runtime.callFunctionOn", {
            objectId           : element.objectId,
            functionDeclaration: "function () { return this.ownerDocument.location.href; }",
            returnByValue      : true,
        }) as { result?: { value?: unknown } } | null;

        href = reply?.result?.value;
    } catch {
        href = undefined;
    }

    if (typeof href !== "string") {
        throw new ToolError(
            "The document of the element could not be checked against safety.allowedDomains. Call the tool again.",
        );
    }

    assertPageAllowed({ config: scope.config }, href, "The element is in a document from");
}

export async function withElement<T>(
    scope : ElementScope,
    tab   : string,
    target: ElementTarget,
    use   : (element: ResolvedElement) => Promise<T>,
): Promise<T> {
    const element = await resolveElement(scope.access, scope.elements, tab, target, {
        frames: scope.frames,
    });

    try {
        if (target.pierce === true) await assertElementDocumentAllowed(scope, tab, element);

        return await use(element);
    } finally {
        await releaseQuietly(elementAccess(scope.access, element), tab, [element.objectId]);
    }
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
