import { type AxNode, INTERACTIVE_ROLES, LANDMARK_ROLES, SKIPPED_ROLES } from "./ax-format.js";

export const A11Y_NAME_CLIP = 200;

const STRUCTURAL_ROLES = new Set(["generic", "inlinetextbox", "linebreak", "ignored"]);

const KEPT_STRUCTURE = new Set(["heading", "image", "img", "list", "table", "figure", "article"]);

const STATE_NAMES = [
    "checked",
    "selected",
    "focused",
    "disabled",
    "expanded",
    "required",
    "readonly",
    "multiline",
    "pressed",
    "invalid",
    "busy",
    "modal",
    "haspopup",
    "visited",
] as const;

const DISPLAY_ROLE: Record<string, string> = { statictext: "text", img: "image" };

export type A11yValue = string | number | boolean;

export interface A11yEntry {
    backendNodeId: number | undefined;
    role         : string;
    name         : string;
    description  : string;
    value        : string | undefined;
    states       : Record<string, A11yValue>;
    level        : number | undefined;
    depth        : number;
    interactive  : boolean;
    unnamed      : boolean;
}

export interface A11yOptions {
    interactiveOnly : boolean;
    includeHidden   : boolean;
    roles?          : readonly string[] | undefined;
    startBackendNode: number | undefined;
    isPassword?     : (backendNodeId: number) => boolean;
}

function clip(text: string, limit: number): string {
    const single = text.replace(/\s+/g, " ").trim();

    return single.length <= limit ? single : `${single.slice(0, limit)}...`;
}

function statesOf(node: AxNode): Record<string, A11yValue> {
    const states: Record<string, A11yValue> = {};

    for (const name of STATE_NAMES) {
        const value = node.properties[name];

        if (value === undefined || value === "") continue;

        states[name] = value === "true" ? true : value === "false" ? false : value;
    }

    return states;
}

function kept(node: AxNode): boolean {
    if (SKIPPED_ROLES.has(node.role) || STRUCTURAL_ROLES.has(node.role)) return false;

    return node.name !== ""
        || INTERACTIVE_ROLES.has(node.role)
        || LANDMARK_ROLES.has(node.role)
        || KEPT_STRUCTURE.has(node.role);
}

// Walks the accessibility tree in document order and keeps the nodes a person or a script would act on or read.
export function a11yEntries(nodes: readonly AxNode[], options: A11yOptions): A11yEntry[] {
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const childOf = new Set(nodes.flatMap((node) => node.childIds));
    const start = options.startBackendNode === undefined
        ? undefined
        : nodes.find((node) => node.backendNodeId === options.startBackendNode);
    const roots = start === undefined
        ? nodes.filter((node) => !childOf.has(node.nodeId))
        : [start];
    const entries: A11yEntry[] = [];
    const wanted = options.roles === undefined
        ? undefined
        : new Set(options.roles.map((role) => role.toLowerCase()));
    const seen = new Set<string>();

    const visit = (node: AxNode, depth: number, parentName: string): void => {
        if (seen.has(node.nodeId)) return;

        seen.add(node.nodeId);

        if (node.hidden && !options.includeHidden) return;

        const interactive = INTERACTIVE_ROLES.has(node.role);
        const textNode = node.role === "statictext";
        const echo = textNode && node.name.trim() === parentName.trim();
        let childDepth = depth;
        let childParent = parentName;

        const include = !node.ignored
            && kept(node)
            && !echo
            && (!options.interactiveOnly || interactive)
            && (wanted === undefined || wanted.has(node.role));

        if (include) {
            const level = node.properties.level;
            const password = node.backendNodeId !== undefined
                && options.isPassword?.(node.backendNodeId) === true;
            const hasValue = node.value !== undefined && node.value !== "" && !password;

            entries.push({
                backendNodeId: node.backendNodeId,
                role         : DISPLAY_ROLE[node.role] ?? node.role,
                name         : clip(node.name, A11Y_NAME_CLIP),
                description  : node.description === node.name ? "" : clip(node.description, A11Y_NAME_CLIP),
                value        : hasValue ? clip(String(node.value), A11Y_NAME_CLIP) : undefined,
                states       : statesOf(node),
                level        : typeof level === "number" ? level : undefined,
                depth,
                interactive,
                unnamed      : interactive && node.name.trim() === "",
            });
            childDepth = depth + 1;
            childParent = node.name;
        } else if (!node.ignored && kept(node)) {
            childParent = node.name;
        }

        for (const id of node.childIds) {
            const child = byId.get(id);

            if (child !== undefined) visit(child, childDepth, childParent);
        }
    };

    for (const root of roots) visit(root, 0, "");

    return entries;
}

export interface A11ySummary {
    roles             : Record<string, number>;
    interactive       : number;
    unnamedInteractive: number;
}

const SUMMARY_ROLES = 30;

export function summarize(entries: readonly A11yEntry[]): A11ySummary {
    const counts = new Map<string, number>();

    for (const entry of entries) counts.set(entry.role, (counts.get(entry.role) ?? 0) + 1);

    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, SUMMARY_ROLES);

    return {
        roles             : Object.fromEntries(top),
        interactive       : entries.filter((entry) => entry.interactive).length,
        unnamedInteractive: entries.filter((entry) => entry.unnamed).length,
    };
}
