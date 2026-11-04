import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import {
    assertElementOriginAllowed,
    elementAccess,
    elementTargetSchema,
    resolveElement,
} from "./element-target.js";
import { ToolError } from "./errors.js";
import { frameChain, mapRect, measureChain } from "./frame-geometry.js";
import { releaseQuietly } from "./remote-objects.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const CSS_MAX_RULES_DEFAULT = 30;

const CSS_MAX_RULES_LIMIT = 100;

const CSS_VALUE_CLIP = 200;

export const DEFAULT_CSS_PROPERTIES = [
    "display",
    "position",
    "top",
    "right",
    "bottom",
    "left",
    "z-index",
    "float",
    "clear",
    "visibility",
    "opacity",
    "overflow",
    "overflow-x",
    "overflow-y",
    "box-sizing",
    "width",
    "height",
    "min-width",
    "min-height",
    "max-width",
    "max-height",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
    "flex-direction",
    "justify-content",
    "align-items",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "color",
    "background-color",
    "text-align",
    "cursor",
];

const INHERITED_PROPERTIES = new Set([
    "color",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "text-align",
    "visibility",
    "cursor",
    "letter-spacing",
    "word-spacing",
    "text-transform",
    "text-indent",
    "white-space",
]);

const describedSchema = z.object({
    node: z.object({ nodeId: z.number(), backendNodeId: z.number() }),
});

const computedSchema = z.object({
    computedStyle: z.array(z.object({ name: z.string(), value: z.string() })),
});

const declarationSchema = z.object({
    name     : z.string(),
    value    : z.string(),
    important: z.boolean().optional(),
});

const ruleSchema = z.object({
    selectorList: z.object({ selectors: z.array(z.object({ text: z.string() })) }),
    origin      : z.string(),
    styleSheetId: z.string().optional(),
    style       : z.object({ cssProperties: z.array(declarationSchema) }),
});

const matchedEntrySchema = z.object({ rule: ruleSchema });

const inheritedEntrySchema = z.object({ matchedCSSRules: z.array(matchedEntrySchema).optional() });

const matchedSchema = z.object({
    matchedCSSRules: z.array(matchedEntrySchema).optional(),
    inherited      : z.array(inheritedEntrySchema).optional(),
});

const quadSchema = z.array(z.number()).length(8);

const boxModelSchema = z.object({
    model: z.object({
        content: quadSchema,
        padding: quadSchema,
        border : quadSchema,
        margin : quadSchema,
    }),
});

interface CssDeclaration {
    name     : string;
    value    : string;
    important: boolean;
    winning  : boolean;
}

interface CssRule {
    selector    : string;
    origin      : string;
    styleSheetId: string | undefined;
    declarations: CssDeclaration[];
}

interface InheritedStyle {
    property: string;
    value   : string;
    selector: string;
}

export function clipCssValue(value: string): string {
    return value.length <= CSS_VALUE_CLIP ? value : value.slice(0, CSS_VALUE_CLIP);
}

export function shapeComputed(
    computed: Array<{ name: string; value: string }>,
    wanted  : string[],
): Record<string, string> {
    const byName = new Map(computed.map((entry) => [entry.name, entry.value]));
    const shaped: Record<string, string> = {};

    for (const name of wanted) {
        const value = byName.get(name);

        if (value !== undefined) shaped[name] = value;
    }

    return shaped;
}

type MatchedEntry = z.infer<typeof matchedEntrySchema>;

type Winner = { rule: number; declaration: number };

function cascadeWinners(entries: MatchedEntry[]): Map<string, Winner> {
    const importantByName = new Set<string>();

    for (const entry of entries) {
        for (const property of entry.rule.style.cssProperties) {
            if (property.name !== "" && (property.important ?? false)) {
                importantByName.add(property.name);
            }
        }
    }

    const last = new Map<string, Winner>();

    entries.forEach((entry, rule) => {
        entry.rule.style.cssProperties.forEach((property, declaration) => {
            const important = property.important ?? false;

            if (property.name === "" || (importantByName.has(property.name) && !important)) return;

            last.set(property.name, { rule, declaration });
        });
    });

    return last;
}

export function droppedWinners(entries: MatchedEntry[], maxRules: number): string[] {
    const firstKept = Math.max(0, entries.length - maxRules);

    return [...cascadeWinners(entries)]
        .filter(([, winner]) => winner.rule < firstKept)
        .map(([name]) => name);
}

export function shapeMatchedRules(
    entries : MatchedEntry[],
    maxRules: number,
): CssRule[] {
    const scored = entries.map((entry, rule) => ({ entry, rule }));
    const last = cascadeWinners(entries);

    const kept = scored.slice(-maxRules);

    return kept.map((item) => {
        const anchor = entries.indexOf(item.entry);

        return {
            selector    : item.entry.rule.selectorList.selectors.map((selector) => selector.text).join(", "),
            origin      : item.entry.rule.origin,
            styleSheetId: item.entry.rule.styleSheetId,
            declarations: item.entry.rule.style.cssProperties
                .filter((property) => property.name !== "")
                .map((property, declaration) => {
                    const winner = last.get(property.name);

                    return {
                        name     : property.name,
                        value    : clipCssValue(property.value),
                        important: property.important ?? false,
                        winning  : winner?.rule === anchor && winner?.declaration === declaration,
                    };
                }),
        };
    });
}

export function shapeInherited(
    inherited: NonNullable<z.infer<typeof matchedSchema>["inherited"]>,
): InheritedStyle[] {
    const shaped: InheritedStyle[] = [];
    const seen = new Set<string>();

    for (const entry of [...inherited].reverse()) {
        for (const matched of [...(entry.matchedCSSRules ?? [])].reverse()) {
            const selector = matched.rule.selectorList.selectors
                .map((item) => item.text)
                .join(", ");

            for (const property of [...matched.rule.style.cssProperties].reverse()) {
                if (!INHERITED_PROPERTIES.has(property.name) || seen.has(property.name)) continue;

                seen.add(property.name);
                shaped.push({
                    property: property.name,
                    value   : clipCssValue(property.value),
                    selector,
                });
            }
        }
    }

    return shaped.reverse();
}

interface CssRect {
    x     : number;
    y     : number;
    width : number;
    height: number;
}

export function quadToRect(quad: number[]): CssRect {
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

const rectSchema = z.strictObject({
    x     : z.number().describe("Left edge in CSS pixels."),
    y     : z.number().describe("Top edge in CSS pixels."),
    width : z.number().describe("Width in CSS pixels."),
    height: z.number().describe("Height in CSS pixels."),
});

export const cssInspect = defineTool({
    name       : "css_inspect",
    description: "Read the computed style, matched CSS rules and box of an element. The box is null for an element without a rendered box, such as display none.",
    access     : "read",
    input      : z.strictObject({
        tab                : tabSchema,
        target             : elementTargetSchema.describe("Element uid from a snapshot or query, or a CSS selector."),
        properties         : z.array(z.string().min(1).max(64)).max(100).optional().describe("Computed style properties to return. Defaults to a curated layout and typography list."),
        includeMatchedRules: z.boolean().optional().describe("Include the matched CSS rules. Defaults to true."),
        maxRules           : z.number().int().min(1).max(CSS_MAX_RULES_LIMIT).optional().describe("Maximum matched rules to return. Defaults to 30."),
        includeBox         : z.boolean().optional().describe("Include the box model. Defaults to true."),
    }),
    output: z.strictObject({
        computed    : z.record(z.string(), z.string()).describe("Requested computed style properties."),
        matchedRules: z.array(z.strictObject({
            selector    : z.string().describe("Selector text of the rule."),
            origin      : z.string().describe("Origin of the rule."),
            styleSheetId: z.string().optional().describe("Style sheet id, when the rule comes from one."),
            declarations: z.array(z.strictObject({
                name     : z.string().describe("Property name."),
                value    : z.string().describe(`Property value, clipped to ${CSS_VALUE_CLIP} characters.`),
                important: z.boolean().describe("Whether the declaration is important."),
                winning  : z.boolean().describe("Whether this is the last declaration of its property in response order, which wins the cascade."),
            })).describe("Declarations of the rule in source order."),
        })).describe("Matched CSS rules in browser order, least specific first."),
        inherited: z.array(z.strictObject({
            property: z.string().describe("Inherited property name."),
            value   : z.string().describe("Inherited value."),
            selector: z.string().describe("Selector the value comes from."),
        })).describe("Inherited properties set on ancestors."),
        box: z.strictObject({
            content: rectSchema.describe("Content rectangle."),
            padding: rectSchema.describe("Padding rectangle."),
            border : rectSchema.describe("Border rectangle."),
            margin : rectSchema.describe("Margin rectangle."),
        }).nullable().describe("Box model rectangles, null when includeBox is false or the element has none."),
        totalRules    : z.number().describe("Matched rules before the maxRules limit."),
        truncated     : z.boolean().describe("Whether maxRules dropped rules."),
        droppedWinners: z.array(z.string()).describe("Properties whose winning declaration is in a rule dropped by maxRules."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        await ensureNoDialog(context.dialogs, targetId);

        const element = await resolveElement(
            context.access,
            context.elements,
            targetId,
            args.target,
            { frames: context.frames },
        );
        const owner = elementAccess(context.access, element);

        try {
            if (element.frameId !== undefined) {
                await assertElementOriginAllowed(
                    { config: context.config, access: context.access },
                    targetId,
                    element,
                );
            }
        } catch (error) {
            await releaseQuietly(owner, targetId, [element.objectId]);

            throw error;
        }

        await releaseQuietly(owner, targetId, [element.objectId]);

        const wanted = args.properties ?? DEFAULT_CSS_PROPERTIES;
        const includeMatchedRules = args.includeMatchedRules ?? true;
        const maxRules = args.maxRules ?? CSS_MAX_RULES_DEFAULT;
        const includeBox = args.includeBox ?? true;

        const described = describedSchema.safeParse(
            await owner.send({
                targetId,
                method: "DOM.describeNode",
                params: {
                    backendNodeId: element.backendNodeId,
                    depth        : 0,
                },
            }),
        );

        if (!described.success) {
            throw new ToolError(
                "The browser sent an unexpected response to DOM.describeNode. Try the call again.",
            );
        }

        const nodeId = described.data.node.nodeId;

        await owner.send({
            targetId,
            method: "DOM.enable",
            params: {},
        });
        await owner.send({
            targetId,
            method: "CSS.enable",
            params: {},
        });

        try {
            const computed = computedSchema.safeParse(
                await owner.send({
                    targetId,
                    method: "CSS.getComputedStyleForNode",
                    params: { nodeId },
                }),
            );

            if (!computed.success) {
                throw new ToolError(
                    "The browser sent an unexpected response to CSS.getComputedStyleForNode. Try the call again.",
                );
            }

            let matchedRules: CssRule[] = [];
            let inherited: InheritedStyle[] = [];
            let totalRules = 0;
            let truncated = false;
            let dropped: string[] = [];

            if (includeMatchedRules) {
                const matched = matchedSchema.safeParse(
                    await owner.send({
                        targetId,
                        method: "CSS.getMatchedStylesForNode",
                        params: { nodeId },
                    }),
                );

                if (!matched.success) {
                    throw new ToolError(
                        "The browser sent an unexpected response to CSS.getMatchedStylesForNode. Try the call again.",
                    );
                }

                const rules = matched.data.matchedCSSRules ?? [];

                matchedRules = shapeMatchedRules(rules, maxRules);
                inherited = shapeInherited(matched.data.inherited ?? []);
                totalRules = rules.length;
                truncated = rules.length > maxRules;
                dropped = droppedWinners(rules, maxRules);
            }

            const local = includeBox ? await readBox(owner, targetId, nodeId) : null;
            const box = local !== null && element.isolated === true && element.frameId !== undefined
                ? await pageBox(context, targetId, element.frameId, local)
                : local;

            return {
                computed      : shapeComputed(computed.data.computedStyle, wanted),
                matchedRules,
                inherited,
                box,
                totalRules,
                truncated,
                droppedWinners: dropped,
            };
        } finally {
            await owner.send({
                targetId,
                method: "CSS.disable",
                params: {},
            }).catch(() => undefined);
        }
    },
});

interface CssBox {
    content: CssRect;
    padding: CssRect;
    border : CssRect;
    margin : CssRect;
}

async function pageBox(
    context : ToolContext,
    targetId: string,
    frameId : string,
    box     : CssBox,
): Promise<CssBox> {
    const chain = await frameChain(context.access, context.frames, targetId, frameId);
    const { toTop } = await measureChain(chain, targetId);

    return {
        content: mapRect(toTop, box.content),
        padding: mapRect(toTop, box.padding),
        border : mapRect(toTop, box.border),
        margin : mapRect(toTop, box.margin),
    };
}

async function readBox(
    access  : DaemonAccess,
    targetId: string,
    nodeId  : number,
): Promise<CssBox | null> {
    let result: unknown;

    try {
        result = await access.send({
            targetId,
            method: "DOM.getBoxModel",
            params: { nodeId },
        });
    } catch {
        return null;
    }

    const parsed = boxModelSchema.safeParse(result);

    if (!parsed.success) return null;

    return {
        content: quadToRect(parsed.data.model.content),
        padding: quadToRect(parsed.data.model.padding),
        border : quadToRect(parsed.data.model.border),
        margin : quadToRect(parsed.data.model.margin),
    };
}
