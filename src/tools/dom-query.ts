import { z } from "zod";
import { ErrorCode, RpcError } from "../daemon/index.js";
import type { DaemonAccess } from "../mcp/index.js";
import { defineTool } from "./define-tool.js";
import { ToolError } from "./errors.js";

export const QUERY_DEFAULT_LIMIT = 20;

export const QUERY_MAX_LIMIT = 200;

export const QUERY_MAX_TEXT_CHARS = 2000;

export const QUERY_CLIP_CHARS = 200;

export const DEFAULT_QUERY_ATTRIBUTES = [
    "id",
    "class",
    "name",
    "type",
    "href",
    "src",
    "value",
    "placeholder",
    "aria-label",
    "role",
    "data-testid",
];

const documentSchema = z.object({ root: z.object({ nodeId: z.number() }) });
const nodeIdSchema = z.object({ nodeId: z.number() });
const nodeIdsSchema = z.object({ nodeIds: z.array(z.number()) });

const describedSchema = z.object({
    node: z.object({
        nodeName     : z.string(),
        localName    : z.string().optional(),
        backendNodeId: z.number(),
        attributes   : z.array(z.string()).optional(),
    }),
});

const rowSchema = z.object({
    tag       : z.string(),
    id        : z.string(),
    classes   : z.array(z.string()),
    attributes: z.record(z.string(), z.string()),
    text      : z.string(),
    visible   : z.boolean(),
    rect      : z.object({
        x     : z.number(),
        y     : z.number(),
        width : z.number(),
        height: z.number(),
    }),
});

const rowsSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.array(rowSchema).optional(),
    }),
});

export type QueryRow = z.infer<typeof rowSchema>;

export function buildQueryScript(selector: string, attributes: string[], count: number): string {
    const matcher = JSON.stringify(selector);
    const names = JSON.stringify(attributes);
    const limit = JSON.stringify(count);

    return `(() => {
  const found = [...document.querySelectorAll(${matcher})].slice(0, ${limit});
  return found.map((el) => {
    const rect = el.getBoundingClientRect();
    const kept = {};
    for (const name of ${names}) {
      const value = el.getAttribute(name);
      if (value !== null) kept[name] = value.slice(0, 500);
    }
    return {
      tag: el.localName,
      id: el.id,
      classes: [...el.classList],
      attributes: kept,
      text: (el.innerText ?? "").slice(0, 500),
      visible: el.getClientRects().length > 0,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
})()`;
}

export function clipValue(value: string, limit: number = QUERY_CLIP_CHARS): string {
    return value.length <= limit ? value : value.slice(0, limit);
}

export function roundRect(rect: QueryRow["rect"]): QueryRow["rect"] {
    return {
        x     : Math.round(rect.x),
        y     : Math.round(rect.y),
        width : Math.round(rect.width),
        height: Math.round(rect.height),
    };
}

export interface DescribedNode {
    backendNodeId: number;
    password     : boolean;
}

export function isPasswordInput(flat: string[]): boolean {
    for (let i = 0; i + 1 < flat.length; i += 2) {
        if (flat[i] === "type" && (flat[i + 1] ?? "").toLowerCase() === "password") return true;
    }

    return false;
}

const matchSchema = z.strictObject({
    uid       : z.string().describe("Element id for later calls."),
    tag       : z.string().describe("Lowercase tag name."),
    id        : z.string().describe("Element id, empty when absent."),
    classes   : z.array(z.string()).describe("Class names."),
    attributes: z.record(z.string(), z.string()).describe("Requested attributes, values clipped to 200 characters."),
    text      : z.string().describe("Visible text, clipped to 200 characters."),
    visible   : z.boolean().describe("Whether the element has a rendered box."),
    box       : z.strictObject({
        x     : z.number().describe("Left edge in CSS pixels."),
        y     : z.number().describe("Top edge in CSS pixels."),
        width : z.number().describe("Width in CSS pixels."),
        height: z.number().describe("Height in CSS pixels."),
    }).nullable().describe("Bounding box, null when includeBox is false or the element has none."),
    redacted: z.boolean().optional().describe("True when a password value was hidden."),
});

export const domQuery = defineTool({
    name       : "dom_query",
    description: "Find elements by a CSS selector and read their text, attributes and boxes.",
    access     : "read",
    input      : z.strictObject({
        tab       : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        selector  : z.string().min(1).max(1024).describe("CSS selector to match."),
        all       : z.boolean().optional().describe("Return every match instead of the first. Defaults to false."),
        limit     : z.number().int().min(1).max(QUERY_MAX_LIMIT).optional().describe("Maximum matches to return. Defaults to 20."),
        text      : z.string().min(1).max(200).optional().describe("Keep only elements whose text contains this, case insensitively."),
        attributes: z.array(z.string().min(1).max(64)).max(50).optional().describe("Attribute names to include."),
        includeBox: z.boolean().optional().describe("Include bounding boxes. Defaults to true."),
    }),
    output: z.strictObject({
        matches : z.array(matchSchema).describe("Matched elements, in document order."),
        total   : z.number().describe("Selector matches, before the text filter and the limit."),
        returned: z.number().describe("Matches in this result, after the text filter and the limit."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        const all = args.all ?? false;
        const limit = all ? (args.limit ?? QUERY_DEFAULT_LIMIT) : 1;
        const names = args.attributes ?? DEFAULT_QUERY_ATTRIBUTES;
        const includeBox = args.includeBox ?? true;

        const root = documentSchema.safeParse(
            await context.access.send(targetId, "DOM.getDocument", { depth: 0, pierce: false }),
        );

        if (!root.success) {
            throw new ToolError(
                "The browser sent an unexpected response to DOM.getDocument. Try the call again.",
            );
        }

        const nodeIds = await matchingNodes(
            context.access,
            targetId,
            root.data.root.nodeId,
            args.selector,
            all,
        );

        if (nodeIds.length === 0) return { matches: [], total: 0, returned: 0 };

        const rows = await queryRows(
            context.access,
            targetId,
            args.selector,
            names,
            nodeIds.length,
            limit,
            args.text,
        );

        if (rows.length === 0) return { matches: [], total: 0, returned: 0 };

        const wanted = rows.length;
        const described = await describeNodes(context.access, targetId, nodeIds.slice(0, wanted));
        const uids = context.elements.assign(
            targetId,
            described.map((node) => ({ backendNodeId: node.backendNodeId })),
        );

        const matches = rows.flatMap((row, index) => {
            const uid = uids[index];
            const node = described[index];

            if (uid === undefined || node === undefined) return [];

            const password = node.password;
            const attributes = password ? { ...row.attributes, value: "" } : row.attributes;

            return [
                {
                    uid,
                    tag       : row.tag,
                    id        : row.id,
                    classes   : row.classes,
                    attributes: attributes,
                    text      : clipValue(row.text),
                    visible   : row.visible,
                    box       : includeBox && row.visible ? roundRect(row.rect) : null,
                    ...(password ? { redacted: true as const } : {}),
                },
            ];
        });

        return { matches, total: nodeIds.length, returned: matches.length };
    },
});

async function matchingNodes(
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

async function queryRows(
    access  : DaemonAccess,
    targetId: string,
    selector: string,
    names   : string[],
    total   : number,
    limit   : number,
    filter  : string | undefined,
): Promise<QueryRow[]> {
    const count = filter === undefined
        ? Math.min(total, limit)
        : Math.min(total, QUERY_MAX_TEXT_CHARS);
    let result: unknown;

    try {
        result = await access.send(
            targetId,
            "Runtime.evaluate",
            { expression: buildQueryScript(selector, names, count), returnByValue: true },
            10_000,
        );
    } catch (error) {
        if (error instanceof RpcError && error.code === ErrorCode.cdpError) {
            throw new ToolError(
                "The page refused to run the query script. The page may restrict script execution.",
            );
        }

        throw error;
    }

    const parsed = rowsSchema.safeParse(result);

    if (!parsed.success || parsed.data.result.type === "undefined") {
        throw new ToolError(
            "The browser sent an unexpected response to the query script. Try the call again.",
        );
    }

    const rows = parsed.data.result.value ?? [];

    if (filter === undefined) return rows.slice(0, limit);

    const needle = filter.toLowerCase();

    return rows.filter((row) => row.text.toLowerCase().includes(needle)).slice(0, limit);
}

async function describeNodes(
    access  : DaemonAccess,
    targetId: string,
    nodeIds : number[],
): Promise<DescribedNode[]> {
    const described: DescribedNode[] = [];

    for (const nodeId of nodeIds) {
        const parsed = describedSchema.safeParse(
            await access.send(targetId, "DOM.describeNode", { nodeId, depth: 0 }),
        );

        if (!parsed.success) {
            throw new ToolError(
                "The browser sent an unexpected response to DOM.describeNode. Try the call again.",
            );
        }

        described.push({
            backendNodeId: parsed.data.node.backendNodeId,
            password     : isPasswordInput(parsed.data.node.attributes ?? []),
        });
    }

    return described;
}
