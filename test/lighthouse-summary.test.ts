import { describe, expect, it } from "vitest";
import { summarizeLighthouse } from "../src/tools/perf/lighthouse-summary.js";

function audit(
    id   : string,
    score: number | null,
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        id,
        title           : `Title of ${id}`,
        description     : `About ${id}. [Learn more](https://example.com/${id}) about it.`,
        score,
        scoreDisplayMode: score === null ? "notApplicable" : "binary",
        ...extra,
    };
}

function report(): unknown {
    const nodes = Array.from({ length: 7 }, (_, index) => ({
        node: { selector: `div:nth-child(${index})`, snippet: `<div class="${"x".repeat(300)}">` },
    }));

    return {
        lighthouseVersion: "13.6.0",
        requestedUrl     : "http://a.example/",
        finalDisplayedUrl: "http://a.example/home",
        runWarnings      : ["The page loaded [slowly](https://x.example).", 5],
        configSettings   : { formFactor: "mobile" },
        timing           : { total: 4987.6 },
        audits           : {
            "button-name"  : audit("button-name", 0, { details: { items: nodes } }),
            "image-alt"    : audit("image-alt", 0.5, { displayValue: "2 elements" }),
            "html-has-lang": audit("html-has-lang", 1),
            "meta-viewport": audit("meta-viewport", 1),
            "not-here"     : audit("not-here", null),
            "manual-check" : audit("manual-check", 0, { scoreDisplayMode: "manual" }),
            "unlisted"     : audit("unlisted", 0),
        },
        categories: {
            accessibility: {
                title    : "Accessibility",
                score    : 0.35,
                auditRefs: [{ id: "button-name" }, { id: "image-alt" }, { id: "html-has-lang" }],
            },
            seo: {
                title    : "SEO",
                score    : null,
                auditRefs: [{ id: "meta-viewport" }, { id: "button-name" }, { id: "manual-check" }],
            },
        },
    };
}

describe("summarizeLighthouse", () => {
    const summary = summarizeLighthouse(report());

    it("reads the run and rounds the scores to whole points", () => {
        expect(summary).toMatchObject({
            version     : "13.6.0",
            url         : "http://a.example/home",
            requestedUrl: "http://a.example/",
            device      : "mobile",
            durationMs  : 4988,
        });
        expect(summary?.scores).toEqual([
            { category: "accessibility", title: "Accessibility", score: 35 },
            { category: "seo", title: "SEO", score: undefined },
        ]);
    });

    it("lists the failed checks of the categories, the worst first, with their categories", () => {
        expect(summary?.failed.map((entry) => [entry.id, entry.score])).toEqual([
            ["button-name", 0],
            ["image-alt", 0.5],
        ]);
        expect(summary?.failed[0]?.categories).toEqual(["accessibility", "seo"]);
        expect(summary?.failed[1]?.displayValue).toBe("2 elements");
        expect(summary?.failedCount).toBe(2);
        expect(summary?.passedCount).toBe(2);
    });

    it("ignores checks that are not scored, not applicable, manual or in no category", () => {
        const ids = summary?.failed.map((entry) => entry.id) ?? [];

        for (const skipped of ["not-here", "manual-check", "unlisted"]) {
            expect(ids).not.toContain(skipped);
        }
    });

    it("shows five failed elements out of all, with a short snippet, and removes links", () => {
        const button = summary?.failed[0];

        expect(button?.totalNodes).toBe(7);
        expect(button?.nodes).toHaveLength(5);
        expect(button?.nodes[0]?.selector).toBe("div:nth-child(0)");
        expect(button?.nodes[0]?.snippet?.length).toBe(160);
        expect(button?.description).toBe("About button-name. Learn more about it.");
        expect(summary?.warnings).toEqual(["The page loaded slowly."]);
    });

    it("lists at most fifteen failed checks and counts all of them", () => {
        const audits: Record<string, unknown> = {};
        const refs: Array<{ id: string }> = [];

        for (let index = 0; index < 20; index += 1) {
            audits[`a${index}`] = audit(`a${index}`, index / 100);
            refs.push({ id: `a${index}` });
        }

        const many = summarizeLighthouse({
            lighthouseVersion: "13.6.0",
            audits,
            categories       : { seo: { title: "SEO", score: 0.1, auditRefs: refs } },
        });

        expect(many?.failed).toHaveLength(15);
        expect(many?.failedCount).toBe(20);
        expect(many?.failed[0]?.id).toBe("a0");
    });

    it("cuts a long description and copes with a report without optional parts", () => {
        const long = summarizeLighthouse({
            lighthouseVersion: "13.6.0",
            audits           : { a: audit("a", 0, { description: "word ".repeat(100) }) },
            categories       : { seo: { title: "SEO", score: 0, auditRefs: [{ id: "a" }] } },
        });

        expect(long?.failed[0]?.description.endsWith("...")).toBe(true);
        expect(long?.url).toBe("");
        expect(long?.device).toBe("unknown");
        expect(long?.durationMs).toBe(0);
        expect(long?.warnings).toEqual([]);
    });

    it.each([[null], [{}], [{ lighthouseVersion: "1" }], ["text"]])(
        "gives up on a report it does not understand",
        (value) => {
            expect(summarizeLighthouse(value)).toBeUndefined();
        },
    );
});
