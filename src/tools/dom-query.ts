import { z } from "zod";
import { ErrorCode, RpcError } from "../daemon/index.js";
import type { DaemonAccess } from "../mcp/index.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { ambiguousFrameError, MAX_FRAME_LENGTH, splitPierceChain } from "./element-target.js";
import { ToolError } from "./errors.js";
import { bindAccess, isolatedDocumentNode } from "./frame-scope.js";
import { elementCollector } from "./walk-script.js";

export const QUERY_DEFAULT_LIMIT = 20;

export const QUERY_MAX_LIMIT = 200;

export const QUERY_MAX_TEXT_CANDIDATES = 2000;

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

const describedSchema = z.object({
    node: z.object({
        nodeName     : z.string(),
        localName    : z.string().optional(),
        backendNodeId: z.number(),
        attributes   : z.array(z.string()).optional(),
    }),
});

const rowSchema = z.object({
    index     : z.number(),
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
        value: z.object({
            rows     : z.array(rowSchema),
            truncated: z.boolean(),
            total    : z.number(),
        }).optional(),
    }),
});

const listSchema = z.object({
    result: z.object({
        type    : z.string().optional(),
        subtype : z.string().optional(),
        objectId: z.string().optional(),
    }),
    exceptionDetails: z.unknown().optional(),
});

const propertiesSchema = z.object({
    result: z.array(z.object({
        name : z.string(),
        value: z.object({ objectId: z.string().optional() }).optional(),
    })),
});

const QUERY_OBJECT_GROUP = "chromium-devtools-mcp-query";
let queryGroupCounter = 0;

export type QueryRow = z.infer<typeof rowSchema>;

export function buildQueryScript(selector: string, count: number): string {
    return `(() => {
  ${elementCollector(selector, false, count)}
  found.walkTruncated = walkTruncated;
  found.total = total;
  return found;
})()`;
}

export function buildPiercedQueryScript(selector: string, count: number): string {
    return `(() => {
  ${elementCollector(selector, true, count)}
  found.walkTruncated = walkTruncated;
  found.total = total;
  return found;
})()`;
}

export function buildRowsFunction(attributes: string[]): string {
    const names = JSON.stringify(attributes);

    return `function () {
  const rows = this.map((el, index) => {
    const rect = el.getBoundingClientRect();
    const kept = {};
    for (const name of ${names}) {
      const value = el.getAttribute(name);
      if (value !== null) kept[name] = value.slice(0, 500);
    }
    return {
      index,
      tag: el.localName,
      id: el.id,
      classes: [...el.classList],
      attributes: kept,
      text: (el.innerText ?? "").slice(0, 500),
      visible: el.getClientRects().length > 0,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
  return { rows, truncated: this.walkTruncated === true, total: this.total };
}`;
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
    description: "Find elements by a CSS selector and read their text, attributes and boxes. Total counts every match in the page; the text filter scans at most the first 2000 matches and pierce visits at most 20000 elements; truncated reports when more matches exist than returned or a cap applied.",
    access     : "read",
    input      : z.strictObject({
        tab       : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        selector  : z.string().min(1).max(1024).describe("CSS selector to match. Use >>> to chain through shadow roots, for example my-app >>> #inner."),
        all       : z.boolean().optional().describe("Return up to limit matches instead of one. Defaults to false."),
        limit     : z.number().int().min(1).max(QUERY_MAX_LIMIT).optional().describe("Maximum matches to return. Defaults to 20 with all and to 1 without it."),
        text      : z.string().min(1).max(200).optional().describe("Keep only elements whose text contains this, case insensitively."),
        attributes: z.array(z.string().min(1).max(64)).max(50).optional().describe("Attribute names to include."),
        includeBox: z.boolean().optional().describe("Include bounding boxes. Defaults to true."),
        pierce    : z.boolean().optional().describe("Match through open shadow roots. Closed shadow roots need a >>> chain. Defaults to false."),
        frame     : z.string().min(1).max(MAX_FRAME_LENGTH).optional().describe("Frame id from dom_snapshot or an iframe CSS selector that matches exactly one iframe. Defaults to the main frame."),
    }),
    output: z.strictObject({
        matches  : z.array(matchSchema).describe("Matched elements, in document order."),
        total    : z.number().describe("Number of elements the selector matches in the page, before the text filter and the limit. A pierce walk counts at most 20000 elements."),
        returned : z.number().describe("Matches in this result, after the text filter and the limit."),
        truncated: z.boolean().describe("True when total is larger than the matches returned, the text filter looked at only the first 2000 selector matches, or a pierce walk stopped after 20000 elements."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        await ensureNoDialog(context.dialogs, targetId);

        const all = args.all ?? false;
        const limit = args.limit ?? (all ? QUERY_DEFAULT_LIMIT : 1);
        const names = args.attributes ?? DEFAULT_QUERY_ATTRIBUTES;
        const includeBox = args.includeBox ?? true;
        const pierce = args.pierce ?? false;
        const chained = splitPierceChain(args.selector) !== undefined;

        if (pierce && chained) {
            throw new ToolError("Pass pierce or a >>> chain, not both: they are two ways to cross shadow roots.");
        }

        const root = documentSchema.safeParse(
            await context.access.send(targetId, "DOM.getDocument", { depth: 0, pierce: false }),
        );

        if (!root.success) {
            throw new ToolError(
                "The browser sent an unexpected response to DOM.getDocument. Try the call again.",
            );
        }

        const scope = await queryScope(context, targetId, root.data.root.nodeId, args.frame);

        if (scope.frameId !== undefined && scope.contextId === undefined) {
            throw new ToolError(
                "The browser refused to open the frame for querying. Try the call again.",
            );
        }

        const scoped = scope.access === undefined
            ? context
            : { ...context, access: scope.access };
        const found = pierce && !chained
            ? await piercedNodes(
                scoped.access,
                targetId,
                args.selector,
                false,
                scope.frameId === undefined ? undefined : scope.nodeId,
            )
            : await (chained ? chainedNodes : matchingNodes)(
                scoped.access,
                targetId,
                scope.nodeId,
                args.selector,
                chained ? limit > 1 : false,
            ).then((ids) => ({ nodeIds: ids, total: ids.length }));
        const { nodeIds } = found;
        const viaRows = !chained;
        const finish = <T extends { matches: unknown[]; returned: number }>(
            result    : T,
            total     : number,
            walkCapped: boolean = false,
        ) => {
            const textCapped = viaRows && args.text !== undefined &&
                total > QUERY_MAX_TEXT_CANDIDATES;
            const more = args.text === undefined
                ? total > result.returned
                : result.returned >= limit && total > result.returned;

            return { ...result, total, truncated: textCapped || more || walkCapped };
        };

        if (nodeIds.length === 0) return { matches: [], total: 0, returned: 0, truncated: false };

        if (!viaRows) {
            return finish(
                await chainedMatches(
                    scoped,
                    targetId,
                    nodeIds,
                    limit,
                    args.text,
                    includeBox,
                    scope.frameId,
                    names,
                ),
                nodeIds.length,
            );
        }

        const { queried, walkCapped, total } = await queryElements(
            scoped.access,
            targetId,
            args.selector,
            names,
            limit,
            args.text,
            { pierce, contextId: scope.contextId },
        );

        if (queried.length === 0) return finish({ matches: [], returned: 0 }, total, walkCapped);

        const frameGeneration = scope.frameId === undefined
            ? undefined
            : context.frames.generation(targetId, scope.frameId);
        const uids = context.elements.assign(
            targetId,
            queried.map(({ node }) => ({
                backendNodeId: node.backendNodeId,
                ...(scope.frameId === undefined ? {} : { frameId: scope.frameId }),
                ...(scope.access === undefined ? {} : { isolated: true }),
                ...(frameGeneration === undefined ? {} : { frameGeneration }),
            })),
        );

        const matches = queried.flatMap(({ row, node }, index) => {
            const uid = uids[index];

            if (uid === undefined) return [];

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

        return finish({ matches, returned: matches.length }, total, walkCapped);
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

interface QueryScope {
    nodeId   : number;
    frameId  : string | undefined;
    contextId: number | undefined;
    access?  : DaemonAccess;
}

async function queryScope(
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

async function chainedNodes(
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

async function piercedNodes(
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

interface QueriedElement {
    row : QueryRow;
    node: DescribedNode;
}

function unexpected(what: string): ToolError {
    return new ToolError(`The browser sent an unexpected response to ${what}. Try the call again.`);
}

async function queryElements(
    access  : DaemonAccess,
    targetId: string,
    selector: string,
    names   : string[],
    limit   : number,
    filter  : string | undefined,
    scope   : { pierce: boolean; contextId: number | undefined },
): Promise<{ queried: QueriedElement[]; walkCapped: boolean; total: number }> {
    const count = filter === undefined ? limit : QUERY_MAX_TEXT_CANDIDATES;
    const expression = scope.pierce
        ? buildPiercedQueryScript(selector, count)
        : buildQueryScript(selector, count);
    const objectGroup = `${QUERY_OBJECT_GROUP}-${(queryGroupCounter += 1)}`;

    try {
        let listed: unknown;

        try {
            listed = await access.send(
                targetId,
                "Runtime.evaluate",
                {
                    expression,
                    objectGroup,
                    returnByValue: false,
                    ...(scope.contextId === undefined ? {} : { contextId: scope.contextId }),
                },
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

        const list = listSchema.safeParse(listed);
        const listId = list.success ? list.data.result.objectId : undefined;

        if (!list.success || listId === undefined || list.data.exceptionDetails !== undefined) {
            throw unexpected("the query script");
        }

        const rowsReply = rowsSchema.safeParse(
            await access.send(targetId, "Runtime.callFunctionOn", {
                objectId           : listId,
                functionDeclaration: buildRowsFunction(names),
                returnByValue      : true,
            }),
        );

        if (!rowsReply.success || rowsReply.data.result.type === "undefined") {
            throw unexpected("the query script");
        }

        const rows = rowsReply.data.result.value?.rows ?? [];
        const walkCapped = rowsReply.data.result.value?.truncated ?? false;
        const total = rowsReply.data.result.value?.total ?? 0;
        const needle = filter?.toLowerCase();
        const chosen = (needle === undefined
            ? rows
            : rows.filter((row) => row.text.toLowerCase().includes(needle))
        ).slice(0, limit);

        if (chosen.length === 0) return { queried: [], walkCapped, total };

        const properties = propertiesSchema.safeParse(
            await access.send(targetId, "Runtime.getProperties", {
                objectId     : listId,
                ownProperties: true,
            }),
        );

        if (!properties.success) throw unexpected("Runtime.getProperties");

        const elementIds = new Map<number, string>();

        for (const property of properties.data.result) {
            const objectId = property.value?.objectId;

            if (objectId !== undefined && /^(0|[1-9][0-9]*)$/.test(property.name)) {
                elementIds.set(Number(property.name), objectId);
            }
        }

        const queried: QueriedElement[] = [];

        for (const row of chosen) {
            const objectId = elementIds.get(row.index);

            if (objectId === undefined) continue;

            const parsed = describedSchema.safeParse(
                await access.send(targetId, "DOM.describeNode", { objectId, depth: 0 }),
            );

            if (!parsed.success) throw unexpected("DOM.describeNode");

            queried.push({
                row,
                node: {
                    backendNodeId: parsed.data.node.backendNodeId,
                    password     : isPasswordInput(parsed.data.node.attributes ?? []),
                },
            });
        }

        return { queried, walkCapped, total };
    } finally {
        await access.send(targetId, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
    }
}

const chainedTextSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.string().optional(),
    }),
});

const CHAINED_TEXT_EXPRESSION = "function (element) { return element.innerText ?? ''; }";

const boxSchema = z.object({
    model: z.object({ content: z.array(z.number()).length(8) }),
});

async function chainedMatches(
    context   : ToolContext,
    targetId  : string,
    nodeIds   : number[],
    limit     : number,
    filter    : string | undefined,
    includeBox: boolean,
    frameId   : string | undefined,
    names     : string[],
): Promise<{ matches: z.infer<typeof matchSchema>[]; returned: number }> {
    const matches: z.infer<typeof matchSchema>[] = [];
    const candidates = filter === undefined ? nodeIds.slice(0, limit) : nodeIds;

    for (const nodeId of candidates) {
        if (matches.length >= limit) break;

        const parsed = describedSchema.safeParse(
            await context.access.send(targetId, "DOM.describeNode", { nodeId, depth: 0 }),
        );

        if (!parsed.success) {
            throw new ToolError(
                "The browser sent an unexpected response to DOM.describeNode. Try the call again.",
            );
        }

        const password = isPasswordInput(parsed.data.node.attributes ?? []);
        const kept: Record<string, string> = {};
        const flat = parsed.data.node.attributes ?? [];
        const all: Record<string, string> = {};

        for (let i = 0; i + 1 < flat.length; i += 2) {
            const name = flat[i] ?? "";
            const value = flat[i + 1] ?? "";

            all[name] = value;

            if (names.includes(name)) kept[name] = password && name === "value" ? "" : value.slice(0, 500);
        }

        const resolved = resolvedSchema.safeParse(
            await context.access.send(targetId, "DOM.resolveNode", { nodeId }).catch(() => undefined),
        );
        let text = "";

        if (resolved.success && resolved.data.object.objectId !== undefined) {
            const objectId = resolved.data.object.objectId;
            const read = chainedTextSchema.safeParse(
                await context.access.send(targetId, "Runtime.callFunctionOn", {
                    functionDeclaration: CHAINED_TEXT_EXPRESSION,
                    objectId           : objectId,
                    arguments          : [{ objectId: objectId }],
                    returnByValue      : true,
                }).catch(() => undefined),
            );

            text = read.success ? (read.data.result.value ?? "") : "";

            await context.access.send(targetId, "Runtime.releaseObject", {
                objectId,
            }).catch(() => undefined);
        }

        if (filter !== undefined && !text.toLowerCase().includes(filter.toLowerCase())) continue;

        let box: { x: number; y: number; width: number; height: number } | null = null;
        let visible = false;

        if (includeBox) {
            const model = boxSchema.safeParse(
                await context.access.send(targetId, "DOM.getBoxModel", { nodeId }).catch(() => undefined),
            );

            if (model.success) {
                const quad = model.data.model.content;
                const xs = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
                const ys = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0];
                const left = Math.min(...xs);
                const top = Math.min(...ys);

                box = {
                    x     : Math.round(left),
                    y     : Math.round(top),
                    width : Math.round(Math.max(...xs) - left),
                    height: Math.round(Math.max(...ys) - top),
                };
                visible = box.width > 0 && box.height > 0;

                if (!visible) box = null;
            }
        }

        const frameGeneration = frameId === undefined
            ? undefined
            : context.frames.generation(targetId, frameId);
        const [uid] = context.elements.assign(targetId, [{
            backendNodeId: parsed.data.node.backendNodeId,
            ...(frameId === undefined ? {} : { frameId }),
            ...(frameGeneration === undefined ? {} : { frameGeneration }),
        }]);

        if (uid === undefined) continue;

        const classes = (all.class ?? "").split(/\s+/).filter((entry) => entry !== "");

        matches.push({
            uid,
            tag       : (parsed.data.node.localName ?? parsed.data.node.nodeName).toLowerCase(),
            id        : all.id ?? "",
            classes,
            attributes: Object.fromEntries(
                Object.entries(kept).map(([name, value]) => [name, clipValue(value)]),
            ),
            text   : clipValue(text),
            visible: includeBox ? visible : true,
            box,
            ...(password ? { redacted: true as const } : {}),
        });
    }

    return { matches, returned: matches.length };
}

const resolvedSchema = z.object({ object: z.object({ objectId: z.string().optional() }) });
