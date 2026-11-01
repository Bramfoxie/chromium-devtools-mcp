import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { toAxNodes, type AxDomInfo, formatAxTree } from "./ax-format.js";
import { defineTool } from "./define-tool.js";
import { assertNoDialog } from "./dialogs.js";
import { elementTargetSchema, resolveElement } from "./element-target.js";
import { ToolError } from "./errors.js";
import { truncateText } from "./result.js";

export const SNAPSHOT_DEFAULT_CHARS = 50_000;

export const SNAPSHOT_MAX_CHARS = 200_000;

export const SNAPSHOT_DOM_DEPTH = 10;

export const SNAPSHOT_DOM_ATTRS = ["href", "src", "type", "placeholder", "id"];

interface DomNodeShape {
    backendNodeId?: unknown;
    nodeName?     : unknown;
    attributes?   : unknown;
    children?     : DomNodeShape[];
}

const domNodeSchema: z.ZodType<DomNodeShape> = z.object({
    backendNodeId: z.unknown().optional(),
    nodeName     : z.unknown().optional(),
    attributes   : z.unknown().optional(),
    children     : z.array(z.lazy(() => domNodeSchema)).optional(),
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
    };

    visit(parsed.data.root);

    return map;
}

async function domInfo(
    access  : DaemonAccess,
    targetId: string,
): Promise<Map<number, AxDomInfo>> {
    const root = await access.send(targetId, "DOM.getDocument", {
        depth : SNAPSHOT_DOM_DEPTH,
        pierce: false,
    });

    return domInfoMap(root);
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
    }),
    output: z.strictObject({
        snapshot  : z.string().describe("Indented text, one node per line: [uid] role \"name\" attributes and state flags."),
        generation: z.number().describe("Uid generation of the tab. Uids of older generations are stale."),
        nodeCount : z.number().describe("Nodes in the snapshot text."),
        omitted   : z.number().describe("Tree nodes left out of the text."),
        truncated : z.boolean().describe("Whether the text was truncated at maxChars."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        assertNoDialog(context.dialogs, targetId);

        const maxChars = args.maxChars ?? SNAPSHOT_DEFAULT_CHARS;
        const interactiveOnly = args.interactiveOnly ?? false;
        const includeHidden = args.includeHidden ?? false;

        let backendNodeId: number | undefined;

        if (args.root !== undefined) {
            const root = await resolveElement(
                context.access,
                context.elements,
                targetId,
                args.root,
            );

            backendNodeId = root.backendNodeId;
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

        const formatted = formatAxTree(nodes, {
            interactiveOnly,
            includeHidden,
            uidFor          : (id) => context.elements.assign(targetId, [{ backendNodeId: id }])[0],
            domFor          : (id) => dom.get(id),
            startBackendNode: backendNodeId,
        });

        const shaped = truncateText(formatted.text, maxChars);

        return {
            snapshot : shaped.text,
            generation,
            nodeCount: formatted.nodeCount,
            omitted  : formatted.omitted,
            truncated: shaped.truncated,
        };
    },
});
