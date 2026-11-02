import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { toAxNodes, type AxDomInfo, formatAxTree } from "./ax-format.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { elementTargetSchema, resolveElement } from "./element-target.js";
import { ToolError } from "./errors.js";
import { truncateText } from "./result.js";

export const SNAPSHOT_DEFAULT_CHARS = 50_000;

export const SNAPSHOT_MAX_CHARS = 200_000;

export const SNAPSHOT_DOM_DEPTH = 10;

export const SNAPSHOT_DOM_ATTRS = ["href", "src", "type", "placeholder", "id"];

export const SNAPSHOT_DEFAULT_MAX_FRAMES = 20;

export const SNAPSHOT_MAX_FRAMES_LIMIT = 50;

interface DomNodeShape {
    backendNodeId?  : unknown;
    nodeName?       : unknown;
    attributes?     : unknown;
    frameId?        : unknown;
    childNodeCount? : unknown;
    children?       : DomNodeShape[];
    shadowRoots?    : DomNodeShape[];
    contentDocument?: DomNodeShape;
}

const domNodeSchema: z.ZodType<DomNodeShape> = z.object({
    backendNodeId  : z.unknown().optional(),
    nodeName       : z.unknown().optional(),
    attributes     : z.unknown().optional(),
    frameId        : z.unknown().optional(),
    childNodeCount : z.unknown().optional(),
    children       : z.array(z.lazy(() => domNodeSchema)).optional(),
    shadowRoots    : z.array(z.lazy(() => domNodeSchema)).optional(),
    contentDocument: z.lazy(() => domNodeSchema).optional(),
});

const documentSchema = z.object({ root: domNodeSchema });

export function domInfoMap(root: unknown): Map<number, AxDomInfo> {
    const parsed = documentSchema.safeParse(root);

    if (!parsed.success) {
        throw new ToolError(
            "The browser sent an unexpected response to DOM.getDocument. Try the call again.",
        );
    }

    const map = new Map<number, AxDomInfo>();
    const visit = (node: z.infer<typeof domNodeSchema>): void => {
        if (typeof node.backendNodeId === "number") {
            const attrs: Record<string, string> = {};
            const flat = Array.isArray(node.attributes) ? node.attributes : [];

            for (let i = 0; i + 1 < flat.length; i += 2) {
                const name = flat[i];
                const value = flat[i + 1];

                if (typeof name === "string" && typeof value === "string") {
                    if (SNAPSHOT_DOM_ATTRS.includes(name)) attrs[name] = value;
                }
            }

            map.set(node.backendNodeId, {
                tag: typeof node.nodeName === "string" ? node.nodeName.toLowerCase() : "",
                attrs,
            });
        }

        for (const child of node.children ?? []) visit(child);
        for (const shadow of node.shadowRoots ?? []) visit(shadow);

        if (node.contentDocument !== undefined) visit(node.contentDocument);
    };

    visit(parsed.data.root);

    return map;
}

export function iframeFrameMap(root: unknown): Map<number, string> {
    const parsed = documentSchema.safeParse(root);

    if (!parsed.success) {
        throw new ToolError(
            "The browser sent an unexpected response to DOM.getDocument. Try the call again.",
        );
    }

    const map = new Map<number, string>();
    const visit = (node: z.infer<typeof domNodeSchema>): void => {
        if (
            (node.nodeName === "IFRAME" || node.nodeName === "FRAME") &&
            typeof node.backendNodeId === "number" && typeof node.frameId === "string"
        ) {
            map.set(node.backendNodeId, node.frameId);
        }

        for (const child of node.children ?? []) visit(child);
        for (const shadow of node.shadowRoots ?? []) visit(shadow);

        if (node.contentDocument !== undefined) visit(node.contentDocument);
    };

    visit(parsed.data.root);

    return map;
}

export function domDepthLimited(root: unknown): boolean {
    const parsed = documentSchema.safeParse(root);

    if (!parsed.success) return false;

    const visit = (node: z.infer<typeof domNodeSchema>): boolean => {
        const count = typeof node.childNodeCount === "number" ? node.childNodeCount : 0;

        if (count > 0 && node.children === undefined && node.contentDocument === undefined) {
            return true;
        }

        return [
            ...(node.children ?? []),
            ...(node.shadowRoots ?? []),
            ...(node.contentDocument === undefined ? [] : [node.contentDocument]),
        ].some(visit);
    };

    return visit(parsed.data.root);
}

export function frameDocBackends(root: unknown): Array<{ frameId: string; backendNodeId: number }> {
    const parsed = documentSchema.safeParse(root);

    if (!parsed.success) {
        throw new ToolError(
            "The browser sent an unexpected response to DOM.getDocument. Try the call again.",
        );
    }

    const found: Array<{ frameId: string; backendNodeId: number }> = [];
    const visit = (node: z.infer<typeof domNodeSchema>): void => {
        if (
            (node.nodeName === "IFRAME" || node.nodeName === "FRAME") &&
            typeof node.frameId === "string" &&
            typeof node.contentDocument?.backendNodeId === "number"
        ) {
            found.push({
                frameId      : node.frameId,
                backendNodeId: node.contentDocument.backendNodeId,
            });
        }

        for (const child of node.children ?? []) visit(child);
        for (const shadow of node.shadowRoots ?? []) visit(shadow);

        if (node.contentDocument !== undefined) visit(node.contentDocument);
    };

    visit(parsed.data.root);

    return found;
}

async function domInfo(
    access  : DaemonAccess,
    targetId: string,
): Promise<{ info: Map<number, AxDomInfo>; root: unknown }> {
    const root = await access.send(targetId, "DOM.getDocument", {
        depth : SNAPSHOT_DOM_DEPTH,
        pierce: true,
    });

    return { info: domInfoMap(root), root };
}

export const domSnapshot = defineTool({
    name: "dom_snapshot",
    description:
        "Read a compact text snapshot of the page with element ids for later calls. Take a new snapshot after the page changes.",
    access: "read",
    input : z.strictObject({
        tab            : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        maxChars       : z.number().int().min(1).max(SNAPSHOT_MAX_CHARS).optional().describe("Maximum characters of the snapshot text. Defaults to 50000."),
        interactiveOnly: z.boolean().optional().describe("List only interactive elements. Defaults to false."),
        root           : elementTargetSchema.optional().describe("Limit the snapshot to the subtree of this element."),
        includeHidden  : z.boolean().optional().describe("Include hidden elements. Defaults to false."),
        maxFrames      : z.number().int().min(0).max(SNAPSHOT_MAX_FRAMES_LIMIT).optional().describe("Maximum iframe contents to include. Defaults to 20. Frames beyond the limit are listed with omitted true."),
    }),
    output: z.strictObject({
        snapshot  : z.string().describe("Indented text, one node per line: [uid] role \"name\" attributes and state flags."),
        generation: z.number().describe("Uid generation of the tab. Uids of older generations are stale."),
        nodeCount : z.number().describe("Nodes in the snapshot text."),
        omitted   : z.number().describe("Tree nodes left out of the text."),
        truncated : z.boolean().describe("Whether the text was truncated at maxChars or the DOM was deeper than the depth limit."),
        frames    : z.array(z.strictObject({
            frameId  : z.string().describe("Frame id for the frame argument of element targets."),
            parent   : z.string().optional().describe("Parent frame id, absent for the main frame."),
            url      : z.string().describe("URL of the frame."),
            isolated : z.boolean().describe("Whether the frame runs in its own process."),
            nodeCount: z.number().describe("Snapshot nodes rendered inside this frame."),
            omitted  : z.boolean().describe("Whether the frame was left out by maxFrames."),
        })).describe("Frames of the tab in tree order, starting with the main frame."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        await ensureNoDialog(context.dialogs, targetId);

        const maxChars = args.maxChars ?? SNAPSHOT_DEFAULT_CHARS;
        const interactiveOnly = args.interactiveOnly ?? false;
        const includeHidden = args.includeHidden ?? false;
        const maxFrames = args.maxFrames ?? SNAPSHOT_DEFAULT_MAX_FRAMES;

        let backendNodeId: number | undefined;

        if (args.root !== undefined) {
            const root = await resolveElement(
                context.access,
                context.elements,
                targetId,
                args.root,
                { frames: context.frames },
            );

            backendNodeId = root.backendNodeId;

            await context.access.send(targetId, "Runtime.releaseObject", {
                objectId: root.objectId,
            }).catch(() => undefined);
        }

        const tree: unknown = backendNodeId === undefined
            ? await context.access.send(targetId, "Accessibility.getFullAXTree", {})
            : await context.access.send(targetId, "Accessibility.getPartialAXTree", {
                backendNodeId,
                fetchRelatives: true,
            });
        const nodes = toAxNodes(tree);
        const dom = await domInfo(context.access, targetId);
        const generation = context.elements.nextGeneration(targetId);
        const ownerFrames = iframeFrameMap(dom.root);

        const formatted = formatAxTree(nodes, {
            interactiveOnly,
            includeHidden,
            uidFor          : (id) => context.elements.assign(targetId, [{ backendNodeId: id }])[0],
            domFor          : (id) => dom.info.get(id),
            startBackendNode: backendNodeId,
            frameFor        : (id) => ownerFrames.get(id),
        });

        const collected = backendNodeId === undefined
            ? await frameSections(context, targetId, dom.root, maxFrames, {
                interactiveOnly,
                includeHidden,
            })
            : { sections: [], omitted: [] as string[] };
        const sections = [formatted.text, ...collected.sections.map((frame) => frame.text)].filter(
            (text) => text !== "",
        );
        const shaped = truncateText(sections.join("\n"), maxChars);
        const depthLimited = backendNodeId === undefined && domDepthLimited(dom.root);
        const snapshot = depthLimited
            ? `${shaped.text}\n[truncated: the DOM is deeper than ${SNAPSHOT_DOM_DEPTH} levels, so content below that depth, including frames, is not listed]`
            : shaped.text;
        const summaries = frameSummaries(context, targetId, collected.sections, collected.omitted);

        return {
            snapshot,
            generation,
            nodeCount: formatted.nodeCount +
                collected.sections.reduce((sum, frame) => sum + frame.count, 0),
            omitted  : formatted.omitted,
            truncated: shaped.truncated || depthLimited,
            frames   : summaries,
        };
    },
});

interface FrameSection {
    frameId: string;
    text   : string;
    count  : number;
}

async function frameSections(
    context  : ToolContext,
    targetId : string,
    root     : unknown,
    maxFrames: number,
    options  : { interactiveOnly: boolean; includeHidden: boolean },
): Promise<{ sections: FrameSection[]; omitted: string[] }> {
    const docs = frameDocBackends(root);

    await context.frames.ensure(targetId).catch(() => undefined);

    const frames = await context.frames.refresh(targetId).catch(() => []);
    const known = new Map(frames.map((frame) => [frame.frameId, frame]));
    const sections: FrameSection[] = [];
    const omitted: string[] = [];

    for (const doc of docs) {
        const info = known.get(doc.frameId);

        if (info === undefined) continue;

        if (sections.length + omitted.length >= maxFrames) {
            omitted.push(doc.frameId);

            continue;
        }

        const partial = await context.access.send(targetId, "Accessibility.getPartialAXTree", {
            backendNodeId : doc.backendNodeId,
            fetchRelatives: true,
        }).catch(() => undefined);

        if (partial === undefined) continue;

        const nodes = toAxNodes(partial);
        const generation = context.frames.generation(targetId, doc.frameId);
        const formatted = formatAxTree(nodes, {
            interactiveOnly: options.interactiveOnly,
            includeHidden  : options.includeHidden,
            uidFor         : (id) =>
                context.elements.assign(targetId, [{
                    backendNodeId  : id,
                    frameId        : doc.frameId,
                    frameGeneration: generation,
                }])[0],
            domFor          : () => undefined,
            startBackendNode: undefined,
        });

        if (formatted.text !== "") {
            sections.push({
                frameId: doc.frameId,
                text   : formatted.text,
                count  : formatted.nodeCount,
            });
        }
    }

    return { sections, omitted };
}

function frameSummaries(
    context : ToolContext,
    targetId: string,
    sections: FrameSection[],
    omitted : string[],
): Array<{
    frameId  : string;
    parent?  : string | undefined;
    url      : string;
    isolated : boolean;
    nodeCount: number;
    omitted  : boolean;
}> {
    const frames = context.frames.framesOf(targetId);
    const counts = new Map(sections.map((section) => [section.frameId, section.count]));
    const leftOut = new Set(omitted);

    return frames.map((frame) => ({
        frameId  : frame.frameId,
        ...(frame.parentFrameId === undefined ? {} : { parent: frame.parentFrameId }),
        url      : frame.url,
        isolated : frame.isolated,
        nodeCount: counts.get(frame.frameId) ?? 0,
        omitted  : leftOut.has(frame.frameId),
    }));
}
