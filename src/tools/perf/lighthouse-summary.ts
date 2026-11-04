import { z } from "zod";
import { redactUrl } from "../capture/redact.js";

const FAILED_SHOWN = 15;

const NODES_SHOWN = 5;

const TEXT_MAX_CHARS = 200;

const SNIPPET_MAX_CHARS = 160;

const WARNINGS_SHOWN = 5;

const LINK = /\[([^\]]*)\]\([^)]*\)/g;

const ADDRESS = /https?:\/\/[^\s"'<>)]+/g;

const nodeSchema = z.object({
    selector: z.string().optional(),
    snippet : z.string().optional(),
});

const auditSchema = z.object({
    id              : z.string(),
    title           : z.string(),
    description     : z.string().optional(),
    score           : z.number().nullable(),
    scoreDisplayMode: z.string(),
    displayValue    : z.string().optional(),
    details         : z.object({ items: z.array(z.unknown()).optional() }).optional(),
});

const reportSchema = z.object({
    lighthouseVersion: z.string(),
    requestedUrl     : z.string().optional(),
    finalDisplayedUrl: z.string().optional(),
    finalUrl         : z.string().optional(),
    runWarnings      : z.array(z.unknown()).optional(),
    configSettings   : z.object({ formFactor: z.string().optional() }).optional(),
    timing           : z.object({ total: z.number().optional() }).optional(),
    audits           : z.record(z.string(), auditSchema),
    categories       : z.record(
        z.string(),
        z.object({
            title    : z.string(),
            score    : z.number().nullable(),
            auditRefs: z.array(z.object({ id: z.string() })),
        }),
    ),
});

export interface AuditNode {
    selector?: string;
    snippet? : string;
}

export interface FailedAudit {
    id           : string;
    title        : string;
    score        : number;
    displayValue?: string;
    description  : string;
    categories   : string[];
    nodes        : AuditNode[];
    totalNodes   : number;
}

export interface LighthouseSummary {
    version     : string;
    url         : string;
    requestedUrl: string;
    device      : string;
    durationMs  : number;
    scores      : Array<{ category: string; title: string; score: number | undefined }>;
    failed      : FailedAudit[];
    failedCount : number;
    passedCount : number;
    warnings    : string[];
}

function redactAddresses(text: string): string {
    return text.replace(ADDRESS, (address) => redactUrl(address));
}

function plain(text: string): string {
    const clean = redactAddresses(text.replace(LINK, "$1")).replace(/\s+/g, " ").trim();

    return clean.length <= TEXT_MAX_CHARS ? clean : `${clean.slice(0, TEXT_MAX_CHARS)}...`;
}

function nodesOf(items: unknown[] | undefined): { nodes: AuditNode[]; total: number } {
    const found: AuditNode[] = [];

    for (const item of items ?? []) {
        const wrapper = z.object({ node: nodeSchema }).safeParse(item);

        if (!wrapper.success) continue;

        const { selector, snippet } = wrapper.data.node;

        const shown = snippet === undefined
            ? undefined
            : redactAddresses(snippet).slice(0, SNIPPET_MAX_CHARS);

        found.push({
            ...(selector === undefined ? {} : { selector }),
            ...(shown === undefined ? {} : { snippet: shown }),
        });
    }

    return { nodes: found.slice(0, NODES_SHOWN), total: found.length };
}

export function summarizeLighthouse(report: unknown): LighthouseSummary | undefined {
    const parsed = reportSchema.safeParse(report);

    if (!parsed.success) return undefined;

    const lhr = parsed.data;
    const membership = new Map<string, string[]>();

    for (const [category, entry] of Object.entries(lhr.categories)) {
        for (const ref of entry.auditRefs) {
            membership.set(ref.id, [...(membership.get(ref.id) ?? []), category]);
        }
    }

    const scored = Object.values(lhr.audits).filter(
        (audit) => audit.score !== null && membership.has(audit.id) &&
            ["binary", "numeric"].includes(audit.scoreDisplayMode),
    );
    const failed = scored
        .filter((audit) => (audit.score ?? 1) < 1)
        .sort((a, b) => (a.score ?? 1) - (b.score ?? 1));

    return {
        version     : lhr.lighthouseVersion,
        url         : redactUrl(lhr.finalDisplayedUrl ?? lhr.finalUrl ?? lhr.requestedUrl ?? ""),
        requestedUrl: redactUrl(lhr.requestedUrl ?? ""),
        device      : lhr.configSettings?.formFactor ?? "unknown",
        durationMs  : Math.round(lhr.timing?.total ?? 0),
        scores      : Object.entries(lhr.categories).map(([category, entry]) => ({
            category,
            title: entry.title,
            score: entry.score === null ? undefined : Math.round(entry.score * 100),
        })),
        failed: failed.slice(0, FAILED_SHOWN).map((audit) => {
            const found = nodesOf(audit.details?.items);

            return {
                id         : audit.id,
                title      : audit.title,
                score      : Math.round((audit.score ?? 0) * 100) / 100,
                ...(audit.displayValue === undefined ? {} : { displayValue: audit.displayValue }),
                description: plain(audit.description ?? ""),
                categories : membership.get(audit.id) ?? [],
                nodes      : found.nodes,
                totalNodes : found.total,
            };
        }),
        failedCount: failed.length,
        passedCount: scored.length - failed.length,
        warnings   : (lhr.runWarnings ?? [])
            .filter((warning): warning is string => typeof warning === "string")
            .slice(0, WARNINGS_SHOWN)
            .map(plain),
    };
}
