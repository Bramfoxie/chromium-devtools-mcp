import { z } from "zod";

const CONTENT_TYPES = new Set([
    "string",
    "concatenated string",
    "sliced string",
    "symbol",
    "number",
    "bigint",
    "regexp",
]);

const DETACHED = 2;

const NAME_MAX_CHARS = 80;

const TAGS_SHOWN = 10;

const STRING_SHARE_WARN = 0.5;

const STRING_BYTES_WARN = 20 * 1024 * 1024;

const ADDRESS = /\s*\/?\s*[a-z][a-z0-9+.-]*:\/\/\S*/gi;

const shapeSchema = z.object({
    snapshot: z.object({
        meta: z.object({
            node_fields: z.array(z.string()),
            node_types : z.array(z.unknown()).min(1),
        }),
    }),
    nodes  : z.array(z.number()),
    strings: z.array(z.string()),
});

export interface HeapClass {
    name : string;
    type : string;
    count: number;
    bytes: number;
}

export interface HeapInsight {
    id    : string;
    level : "warn" | "poor";
    title : string;
    detail: string;
}

export interface HeapSummary {
    totalBytes: number;
    nodeCount : number;
    byType    : Array<{ type: string; count: number; bytes: number }>;
    classes   : HeapClass[];
    detached  : { count: number; tags: Array<{ tag: string; count: number }> };
    insights  : HeapInsight[];
}

// The name of a string node is the string itself, so those nodes are told apart by type only.
function labelOf(type: string, name: string): string {
    if (CONTENT_TYPES.has(type)) return `(${type})`;

    const clean = name.replace(ADDRESS, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX_CHARS);

    return clean === "" ? "(unnamed)" : clean;
}

function tagOf(name: string): string {
    const match = /^<([a-z][a-z0-9-]*)/i.exec(name);

    return match?.[1]?.toLowerCase() ?? "(other)";
}

function insightsOf(summary: Omit<HeapSummary, "insights">): HeapInsight[] {
    const found: HeapInsight[] = [];

    if (summary.detached.count > 0) {
        const tags = summary.detached.tags.map((entry) => `${entry.tag} x${entry.count}`).join(", ");

        found.push({
            id    : "detached-dom",
            level : "warn",
            title : `${summary.detached.count} detached DOM nodes`,
            detail: `They are no longer in the page but JavaScript still holds them, so they stay in memory: ${tags}.`,
        });
    }

    const strings = summary.byType
        .filter((entry) => CONTENT_TYPES.has(entry.type))
        .reduce((sum, entry) => sum + entry.bytes, 0);

    const share = summary.totalBytes > 0 ? strings / summary.totalBytes : 0;

    if (strings > STRING_BYTES_WARN && share > STRING_SHARE_WARN) {
        found.push({
            id    : "string-heavy",
            level : "warn",
            title : `Strings take ${Math.round((strings / summary.totalBytes) * 100)}% of the heap`,
            detail: `${strings} of ${summary.totalBytes} bytes are strings, for example repeated text or large payloads kept in memory.`,
        });
    }

    return found;
}

export function summarizeHeap(snapshot: unknown, top: number): HeapSummary | undefined {
    const parsed = shapeSchema.safeParse(snapshot);

    if (!parsed.success) return undefined;

    const { node_fields: fields, node_types: types } = parsed.data.snapshot.meta;
    const typeNames = Array.isArray(types[0]) ? types[0].map(String) : [];
    const stride = fields.length;
    const at = {
        type    : fields.indexOf("type"),
        name    : fields.indexOf("name"),
        size    : fields.indexOf("self_size"),
        detached: fields.indexOf("detachedness"),
    };

    if (stride === 0 || at.type < 0 || at.name < 0 || at.size < 0) return undefined;

    const { nodes, strings } = parsed.data;
    const classes = new Map<string, HeapClass>();
    const byType = new Map<string, { type: string; count: number; bytes: number }>();
    const tags = new Map<string, number>();
    let total = 0;
    let detached = 0;

    for (let index = 0; index + stride <= nodes.length; index += stride) {
        const type = typeNames[nodes[index + at.type] ?? -1] ?? "unknown";
        const size = nodes[index + at.size] ?? 0;
        const name = strings[nodes[index + at.name] ?? -1] ?? "";
        const label = labelOf(type, name);
        const key = `${type}\u0000${label}`;
        const group = classes.get(key) ?? { name: label, type, count: 0, bytes: 0 };
        const kind = byType.get(type) ?? { type, count: 0, bytes: 0 };

        group.count += 1;
        group.bytes += size;
        kind.count += 1;
        kind.bytes += size;
        classes.set(key, group);
        byType.set(type, kind);
        total += size;

        if (at.detached >= 0 && nodes[index + at.detached] === DETACHED) {
            detached += 1;
            tags.set(tagOf(name), (tags.get(tagOf(name)) ?? 0) + 1);
        }
    }

    const summary: Omit<HeapSummary, "insights"> = {
        totalBytes: total,
        nodeCount : Math.floor(nodes.length / stride),
        byType    : [...byType.values()].sort((a, b) => b.bytes - a.bytes),
        classes   : [...classes.values()].sort((a, b) => b.bytes - a.bytes).slice(0, top),
        detached  : {
            count: detached,
            tags : [...tags]
                .sort((a, b) => b[1] - a[1])
                .slice(0, TAGS_SHOWN)
                .map(([tag, count]) => ({ tag, count })),
        },
    };

    return { ...summary, insights: insightsOf(summary) };
}
