import path from "node:path";
import { z } from "zod";
import { defineTool } from "../define-tool.js";
import { ToolError } from "../errors.js";
import { throwIfCancelled } from "../registry.js";
import { resolveTab, tabSchema } from "../tab-target.js";
import { summarizeLighthouse } from "./lighthouse-summary.js";

const CATEGORIES = ["accessibility", "best-practices", "seo", "performance"] as const;

const DEFAULT_CATEGORIES = ["accessibility", "best-practices", "seo"] as const;

const TIMEOUT_DEFAULT_MS = 120_000;

const TIMEOUT_MAX_MS = 300_000;

const REPORT_BASE = "report";

const NOT_INSTALLED =
    "Lighthouse is not installed on this machine, so the audit cannot run. Ask the user to install it with `npm install -g lighthouse` (it needs Node.js 22.19 or newer), then call this tool again. Nothing was changed.";

const nodeSchema = z.strictObject({
    selector: z.string().optional().describe("CSS selector of the element."),
    snippet : z.string().optional().describe("Start of the element markup."),
});

function auditedUrl(value: string): string {
    let parsed: URL | undefined;

    try {
        parsed = new URL(value);
    } catch {
        parsed = undefined;
    }

    if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        throw new ToolError(
            "Lighthouse audits http and https pages only. Pass url, or select a tab that shows one.",
        );
    }

    return parsed.href;
}

export const lighthouseAudit = defineTool({
    name       : "lighthouse_audit",
    closedWorld: false,
    description:
        "Audit a page with the Lighthouse program installed on this machine and report the scores and the failed checks for accessibility, best practices and SEO (performance is optional; perf_trace_stop measures it better). It loads the page in a separate clean browser, so it sees the page as a new visitor without the logins of your tabs and does not touch your tabs. When Lighthouse is not installed the call fails and says what the user has to install.",
    access      : "mutate",
    tabUrlExempt: (args) => args.url !== undefined,
    target      : (args) => (args.url === undefined ? undefined : { url: args.url }),
    input       : z.strictObject({
        tab       : tabSchema,
        url       : z.string().min(1).max(2048).optional().describe("Page to audit, http or https. Defaults to the page of the tab."),
        categories: z.array(z.enum(CATEGORIES)).min(1).max(4).optional().describe("What to audit. Defaults to accessibility, best-practices and seo."),
        device    : z.enum(["desktop", "mobile"]).optional().describe("Screen and network to emulate. Defaults to desktop."),
        timeoutMs : z.number().int().min(10_000).max(TIMEOUT_MAX_MS).optional().describe(`How long to wait for the audit, 10000 to ${TIMEOUT_MAX_MS} ms. Defaults to ${TIMEOUT_DEFAULT_MS}.`),
    }),
    output: z.strictObject({
        version     : z.string().describe("Version of Lighthouse that ran."),
        url         : z.string().describe("Address the audit ended on."),
        requestedUrl: z.string().describe("Address that was asked for."),
        device      : z.string().describe("Emulated device."),
        durationMs  : z.number().describe("How long Lighthouse took."),
        scores      : z.array(z.strictObject({
            category: z.string().describe("Category id."),
            title   : z.string(),
            score   : z.number().optional().describe("Score from 0 to 100, absent when Lighthouse gave none."),
        })),
        failed: z.array(z.strictObject({
            id          : z.string().describe("Lighthouse audit id."),
            title       : z.string(),
            score       : z.number().describe("Score from 0 to 1."),
            displayValue: z.string().optional(),
            description : z.string().describe("What the check is about, links removed."),
            categories  : z.array(z.string()),
            nodes       : z.array(nodeSchema).describe("Up to 5 elements that failed."),
            totalNodes  : z.number().describe("How many elements failed."),
        })).describe("The failed checks, the worst first, at most 15."),
        failedCount: z.number().describe("All failed checks, also those not listed."),
        passedCount: z.number().describe("Checks that passed."),
        warnings   : z.array(z.string()).describe("Warnings Lighthouse gave about the run."),
        reports    : z.strictObject({
            json: z.string().describe("Absolute path of the full report as JSON."),
            html: z.string().describe("Absolute path of the report that opens in a browser."),
        }),
    }),
    handler: async (args, context) => {
        throwIfCancelled(context.signal);

        const program = await context.lighthouse.find();

        if (program === undefined) throw new ToolError(NOT_INSTALLED);

        const url = auditedUrl(
            args.url ?? (await tabUrl(context, resolveTab(args, context))),
        );
        const categories = args.categories ?? [...DEFAULT_CATEGORIES];
        const device = args.device ?? "desktop";
        const dir = await context.artifacts.directory("lighthouse");
        const chrome = context.lighthouse.chromePath();
        const outcome = await context.lighthouse.run(
            program,
            [
                url,
                "--output=json",
                "--output=html",
                `--output-path=${path.join(dir.path, REPORT_BASE)}`,
                "--quiet",
                "--chrome-flags=--headless=new",
                `--only-categories=${categories.join(",")}`,
                device === "desktop" ? "--preset=desktop" : "--form-factor=mobile",
            ],
            dir.path,
            args.timeoutMs ?? TIMEOUT_DEFAULT_MS,
            { ...process.env, ...(chrome === undefined ? {} : { CHROME_PATH: chrome }) },
            context.signal,
        );

        throwIfCancelled(context.signal);

        if (!outcome.ok) {
            throw new ToolError(
                `Lighthouse failed: ${outcome.error} Check that the page loads and that Chrome is installed.`,
            );
        }

        const json = path.join(dir.path, `${REPORT_BASE}.report.json`);
        const html = path.join(dir.path, `${REPORT_BASE}.report.html`);
        let report: unknown;

        try {
            report = JSON.parse(await context.lighthouse.read(json));
        } catch {
            throw new ToolError(
                "Lighthouse finished but its report could not be read. Run the audit again.",
            );
        }

        const summary = summarizeLighthouse(report);

        if (summary === undefined) {
            throw new ToolError("The Lighthouse report has a format this server does not know.");
        }

        return {
            version     : summary.version,
            url         : summary.url,
            requestedUrl: summary.requestedUrl,
            device      : summary.device,
            durationMs  : summary.durationMs,
            scores      : summary.scores,
            failed      : summary.failed,
            failedCount : summary.failedCount,
            passedCount : summary.passedCount,
            warnings    : summary.warnings,
            reports     : { json, html },
        };
    },
});

async function tabUrl(
    context : { access: { listTabs(scope: "owned" | "available"): Promise<Array<{ targetId: string; url: string }>> } },
    targetId: string,
): Promise<string> {
    const tabs = await context.access.listTabs("owned");

    return tabs.find((tab) => tab.targetId === targetId)?.url ?? "";
}
