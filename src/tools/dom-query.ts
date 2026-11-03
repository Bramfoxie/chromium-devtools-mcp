import { z } from "zod";
import { ErrorCode, RpcError } from "../daemon/index.js";
import type { DaemonAccess } from "../mcp/index.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import { MAX_FRAME_LENGTH, splitPierceChain } from "./element-target.js";
import { chainedNodes, matchingNodes, piercedNodes, queryScope } from "./dom-query-nodes.js";
import {
    buildPiercedQueryScript,
    buildQueryScript,
    buildRowsFunction,
    clipValue,
    DEFAULT_QUERY_ATTRIBUTES,
    isPasswordInput,
    QUERY_DEFAULT_LIMIT,
    QUERY_MAX_LIMIT,
    QUERY_MAX_TEXT_CANDIDATES,
    roundRect,
    describedSchema,
    matchSchema,
    rowsSchema,
    type DescribedNode,
    type QueryRow,
} from "./dom-query-rows.js";
import { ToolError } from "./errors.js";
import { documentSchema, resolvedSchema } from "./cdp-schemas.js";
import { releaseGroupQuietly, releaseQuietly } from "./remote-objects.js";
import { resolveTab, tabSchema } from "./tab-target.js";

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

export const domQuery = defineTool({
    name       : "dom_query",
    description: "Find elements by a CSS selector and read their text, attributes and boxes. Total counts every match in the page; the text filter scans at most the first 2000 matches and pierce visits at most 20000 elements; truncated reports when more matches exist than returned or a cap applied.",
    access     : "read",
    input      : z.strictObject({
        tab       : tabSchema,
        selector  : z.string().min(1).max(1024).describe("CSS selector to match. Use >>> to chain through shadow roots, for example my-app >>> #inner."),
        all       : z.boolean().optional().describe("Return up to limit matches instead of one. Defaults to false."),
        limit     : z.number().int().min(1).max(QUERY_MAX_LIMIT).optional().describe(`Maximum matches to return. Defaults to ${QUERY_DEFAULT_LIMIT} with all and to 1 without it.`),
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
        truncated: z.boolean().describe(`True when total is larger than the matches returned, the text filter looked at only the first ${QUERY_MAX_TEXT_CANDIDATES} selector matches, or a pierce walk stopped after 20000 elements.`),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

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
            await context.access.send({
                targetId,
                method: "DOM.getDocument",
                params: { depth: 0, pierce: false },
            }),
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
            listed = await access.send({
                targetId,
                method: "Runtime.evaluate",
                params: {
                    expression,
                    objectGroup,
                    returnByValue: false,
                    ...(scope.contextId === undefined ? {} : { contextId: scope.contextId }),
                },
                timeoutMs: 10_000,
            });
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
            await access.send({
                targetId,
                method: "Runtime.callFunctionOn",
                params: {
                    objectId           : listId,
                    functionDeclaration: buildRowsFunction(names),
                    returnByValue      : true,
                },
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
            await access.send({
                targetId,
                method: "Runtime.getProperties",
                params: {
                    objectId     : listId,
                    ownProperties: true,
                },
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
                await access.send({
                    targetId,
                    method: "DOM.describeNode",
                    params: { objectId, depth: 0 },
                }),
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
        await releaseGroupQuietly(access, targetId, objectGroup);
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
            await context.access.send({
                targetId,
                method: "DOM.describeNode",
                params: { nodeId, depth: 0 },
            }),
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
            await context.access.send({
                targetId,
                method: "DOM.resolveNode",
                params: { nodeId },
            }).catch(() => undefined),
        );
        let text = "";

        if (resolved.success && resolved.data.object.objectId !== undefined) {
            const objectId = resolved.data.object.objectId;
            const read = chainedTextSchema.safeParse(
                await context.access.send({
                    targetId,
                    method: "Runtime.callFunctionOn",
                    params: {
                        functionDeclaration: CHAINED_TEXT_EXPRESSION,
                        objectId           : objectId,
                        arguments          : [{ objectId: objectId }],
                        returnByValue      : true,
                    },
                }).catch(() => undefined),
            );

            text = read.success ? (read.data.result.value ?? "") : "";

            await releaseQuietly(context.access, targetId, [objectId]);
        }

        if (filter !== undefined && !text.toLowerCase().includes(filter.toLowerCase())) continue;

        let box: { x: number; y: number; width: number; height: number } | null = null;
        let visible = false;

        if (includeBox) {
            const model = boxSchema.safeParse(
                await context.access.send({
                    targetId,
                    method: "DOM.getBoxModel",
                    params: { nodeId },
                }).catch(() => undefined),
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
