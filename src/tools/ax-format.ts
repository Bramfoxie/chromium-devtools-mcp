import { z } from "zod";
import { ToolError } from "./errors.js";

export const AX_NAME_CLIP = 100;

const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "textbox",
    "searchbox",
    "combobox",
    "listbox",
    "checkbox",
    "radio",
    "switch",
    "slider",
    "spinbutton",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "treeitem",
    "option",
    "gridcell",
    "row",
]);

const LANDMARK_ROLES = new Set([
    "banner",
    "complementary",
    "contentinfo",
    "main",
    "navigation",
    "region",
    "search",
    "form",
    "dialog",
    "alertdialog",
]);

const SKIPPED_ROLES = new Set(["rootwebarea", "webarea", "none", "presentation"]);

const VALUE_ROLES = new Set([
    "textbox",
    "searchbox",
    "combobox",
    "spinbutton",
    "slider",
    "progressbar",
    "meter",
]);

const STATE_FLAGS = [
    "checked",
    "selected",
    "focused",
    "disabled",
    "expanded",
    "collapsed",
    "required",
    "readonly",
    "multiline",
    "visited",
];

const DISPLAY_ROLE: Record<string, string> = { statictext: "text" };

export interface AxNode {
    nodeId       : string;
    ignored      : boolean;
    role         : string;
    name         : string;
    description  : string;
    value        : string | number | boolean | undefined;
    hidden       : boolean;
    properties   : Record<string, string | number | boolean>;
    childIds     : string[];
    backendNodeId: number | undefined;
}

export interface AxDomInfo {
    tag  : string;
    attrs: Record<string, string>;
}

interface AxFormatOptions {
    interactiveOnly : boolean;
    includeHidden   : boolean;
    uidFor          : (backendNodeId: number) => string | undefined;
    domFor          : (backendNodeId: number) => AxDomInfo | undefined;
    startBackendNode: number | undefined;
    frameFor?       : (backendNodeId: number) => string | undefined;
}

interface AxFormatResult {
    text     : string;
    nodeCount: number;
    omitted  : number;
}

const nameSchema = z.object({ value: z.unknown().optional() });

const propertySchema = z.object({
    name : z.string(),
    value: z.object({ value: z.unknown().optional() }),
});

const nodeSchema = z.object({
    nodeId          : z.string(),
    ignored         : z.boolean().optional(),
    role            : nameSchema.extend({ value: z.unknown().optional() }).optional(),
    name            : nameSchema.optional(),
    description     : nameSchema.optional(),
    value           : nameSchema.optional(),
    properties      : z.array(propertySchema).optional(),
    childIds        : z.array(z.string()).optional(),
    backendDOMNodeId: z.number().optional(),
});

const treeSchema = z.object({ nodes: z.array(nodeSchema) });

function textOf(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function scalarOf(value: unknown): string | number | boolean | undefined {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? value
        : undefined;
}

export function toAxNodes(raw: unknown): AxNode[] {
    const parsed = treeSchema.safeParse(raw);

    if (!parsed.success) {
        throw new ToolError(
            "The browser sent an unexpected accessibility tree. Try the call again.",
        );
    }

    return parsed.data.nodes.map((node) => {
        const properties: Record<string, string | number | boolean> = {};

        for (const property of node.properties ?? []) {
            const scalar = scalarOf(property.value.value);

            if (scalar !== undefined) properties[property.name] = scalar;
        }

        return {
            nodeId       : node.nodeId,
            ignored      : node.ignored ?? false,
            role         : textOf(node.role?.value).toLowerCase(),
            name         : textOf(node.name?.value),
            description  : textOf(node.description?.value),
            value        : scalarOf(node.value?.value),
            hidden       : properties.hidden === true || properties.invisible === true,
            properties,
            childIds     : node.childIds ?? [],
            backendNodeId: node.backendDOMNodeId,
        };
    });
}

function clipAxText(value: string, limit: number = AX_NAME_CLIP): string {
    const single = value.replace(/\s+/g, " ");

    return single.length <= limit ? single : `${single.slice(0, limit)}...`;
}

function quote(value: string): string {
    return `"${clipAxText(value).replace(/"/g, "'")}"`;
}

function isFrameRole(role: string): boolean {
    return role === "iframe" || role === "frame";
}

function wantsUid(node: AxNode): boolean {
    if (isFrameRole(node.role)) return true;
    if (SKIPPED_ROLES.has(node.role)) return false;
    if (INTERACTIVE_ROLES.has(node.role)) return true;
    if (LANDMARK_ROLES.has(node.role)) return true;

    return node.name !== "";
}

function displayRole(node: AxNode): string {
    const role = DISPLAY_ROLE[node.role] ?? node.role;

    if (node.role === "heading") {
        const level = node.properties.level;

        if (typeof level === "number") return `heading level ${level}`;
    }

    return role;
}

function lineFor(node: AxNode, uid: string, options: AxFormatOptions): string {
    const parts = [`[${uid}]`, displayRole(node)];

    if (node.name !== "") parts.push(quote(node.name));

    const dom = node.backendNodeId === undefined ? undefined : options.domFor(node.backendNodeId);

    if (node.role === "link") {
        const href = dom?.attrs.href;

        if (href !== undefined && href !== "") parts.push(`href=${quote(href)}`);
    }

    if (node.role === "image") {
        const src = dom?.attrs.src;

        if (src !== undefined && src !== "") parts.push(`src=${quote(src)}`);
    }

    if (node.role === "textbox" || node.role === "searchbox") {
        const type = dom?.attrs.type;

        if (type !== undefined && type !== "" && type.toLowerCase() !== "text") {
            parts.push(`type=${quote(type)}`);
        }

        const placeholder = dom?.attrs.placeholder;

        if (placeholder !== undefined && placeholder !== "") {
            parts.push(`placeholder=${quote(placeholder)}`);
        }
    }

    if (VALUE_ROLES.has(node.role) && node.value !== undefined) {
        const password = dom !== undefined && dom.tag === "input" &&
            (dom.attrs.type ?? "").toLowerCase() === "password";

        parts.push(password ? `value=""` : `value=${quote(String(node.value))}`);
    }

    for (const flag of STATE_FLAGS) {
        const value = node.properties[flag];

        if (value === true) {
            parts.push(flag);
        } else if (value !== undefined && value !== false && value !== "") {
            parts.push(`${flag}=${value}`);
        }
    }

    if (node.description !== "" && node.description !== node.name) {
        parts.push(`desc=${quote(node.description)}`);
    }

    if (isFrameRole(node.role)) {
        const frameId = node.backendNodeId === undefined
            ? undefined
            : options.frameFor?.(node.backendNodeId);

        if (frameId !== undefined) parts.push(`frame=${frameId}`);
    }

    return parts.join(" ");
}

export function formatAxTree(nodes: AxNode[], options: AxFormatOptions): AxFormatResult {
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const hasParent = new Set<string>();

    for (const node of nodes) {
        for (const child of node.childIds) {
            if (byId.has(child)) hasParent.add(child);
        }
    }

    const roots = nodes.filter((node) => !hasParent.has(node.nodeId));
    const lines: string[] = [];
    const visited = new Set<string>();
    let nodeCount = 0;
    let omitted = 0;

    const visit = (node: AxNode, depth: number): void => {
        if (visited.has(node.nodeId)) {
            omitted += 1;

            return;
        }

        visited.add(node.nodeId);

        const hidden = node.ignored || node.hidden;
        const wanted = (!hidden || options.includeHidden) &&
            (!options.interactiveOnly || INTERACTIVE_ROLES.has(node.role) ||
                isFrameRole(node.role)) &&
            wantsUid(node);

        let uid: string | undefined;

        if (wanted) {
            uid = node.backendNodeId === undefined ? undefined : options.uidFor(node.backendNodeId);
        }

        if (wanted && uid !== undefined) {
            lines.push(`${"  ".repeat(depth)}${lineFor(node, uid, options)}`);
            nodeCount += 1;
        } else {
            omitted += 1;
        }

        const emit = wanted && uid !== undefined;

        const next = emit ? depth + 1 : depth;

        for (const child of node.childIds) {
            const found = byId.get(child);

            if (found !== undefined) visit(found, next);
        }
    };

    if (options.startBackendNode !== undefined) {
        const start = nodes.find((node) => node.backendNodeId === options.startBackendNode);

        if (start === undefined) {
            throw new ToolError("The root element is gone from the page. Run the call again.");
        }

        visit(start, 0);

        return { text: lines.join("\n"), nodeCount, omitted };
    }

    const starts = roots.length === 0 ? nodes : roots;

    for (const root of starts) visit(root, 0);

    return { text: lines.join("\n"), nodeCount, omitted };
}
