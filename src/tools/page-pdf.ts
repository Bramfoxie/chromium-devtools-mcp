import { z } from "zod";
import { defineTool } from "./define-tool.js";
import { ToolError } from "./errors.js";
import { binaryResult, resourceBlock } from "./result.js";

export const PDF_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export const PDF_MAX_BYTES_LIMIT = 24 * 1024 * 1024;

export const PDF_A4_WIDTH_INCHES = 8.27;

export const PDF_A4_HEIGHT_INCHES = 11.69;

export const PDF_DEFAULT_MARGIN_INCHES = 0.4;

export const PDF_PAGE_RANGES_MAX_CHARS = 100;

const PAGE_RANGES_PATTERN = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;

const pdfSchema = z.object({ data: z.string().min(1) });

const marginSchema = z.strictObject({
    top   : z.number().min(0).max(20).optional(),
    bottom: z.number().min(0).max(20).optional(),
    left  : z.number().min(0).max(20).optional(),
    right : z.number().min(0).max(20).optional(),
}).optional();

export function validPageRanges(ranges: string): boolean {
    if (ranges.length > PDF_PAGE_RANGES_MAX_CHARS) return false;
    if (!PAGE_RANGES_PATTERN.test(ranges)) return false;

    return ranges.split(",").every((part) => {
        const [from = "", to = from] = part.split("-");
        const start = Number(from);
        const end = Number(to);

        return start >= 1 && end >= start;
    });
}

export function countPdfPages(bytes: Uint8Array): number | undefined {
    const text = Buffer.from(bytes).toString("latin1");
    const matches = text.match(/\/Type\s*\/Page[^s]/g);

    if (!matches || matches.length === 0) return undefined;

    return matches.length;
}

const pdfOutput = z.strictObject({
    bytes   : z.number().describe("PDF size in bytes."),
    pages   : z.number().optional().describe("Page count, when it can be read from the file."),
    uri     : z.string().describe("URI of the embedded PDF resource."),
    data    : z.string().describe("Base64 encoded PDF, presented as a resource block."),
    mimeType: z.string().describe("MIME type of the PDF."),
});

export const pagePdf = defineTool({
    name: "page_pdf",
    description:
        "Print a tab to PDF. Needs a headless managed browser when the headed browser refuses to print.",
    access: "read",
    input : z.strictObject({
        tab              : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        landscape        : z.boolean().optional().describe("Use landscape orientation. Defaults to false."),
        printBackground  : z.boolean().optional().describe("Print background graphics. Defaults to true."),
        scale            : z.number().min(0.1).max(2).optional().describe("Scale factor. Defaults to 1."),
        paperWidth       : z.number().min(1).max(100).optional().describe("Paper width in inches. Defaults to A4."),
        paperHeight      : z.number().min(1).max(100).optional().describe("Paper height in inches. Defaults to A4."),
        margins          : marginSchema.describe("Margins in inches. Defaults to 0.4 on every side."),
        pageRanges       : z.string().min(1).max(PDF_PAGE_RANGES_MAX_CHARS).optional().describe("Page ranges like 1-3,5."),
        preferCSSPageSize: z.boolean().optional().describe("Prefer the CSS page size. Defaults to false."),
        maxBytes         : z.number().int().min(1024).max(PDF_MAX_BYTES_LIMIT).optional().describe("Maximum PDF bytes. Defaults to 8 MiB."),
    }).superRefine((value, ctx) => {
        if (value.pageRanges !== undefined && !validPageRanges(value.pageRanges)) {
            ctx.addIssue({ code: "custom", message: "Page ranges look like 1-3,5 with positive pages." });
        }
    }),
    output : pdfOutput,
    present: (output) => {
        const { data, mimeType, uri, ...small } = output;

        return binaryResult({ ...small, uri }, resourceBlock(uri, { data, mimeType }));
    },
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        const maxBytes = args.maxBytes ?? PDF_DEFAULT_MAX_BYTES;
        const margins = {
            top   : args.margins?.top ?? PDF_DEFAULT_MARGIN_INCHES,
            bottom: args.margins?.bottom ?? PDF_DEFAULT_MARGIN_INCHES,
            left  : args.margins?.left ?? PDF_DEFAULT_MARGIN_INCHES,
            right : args.margins?.right ?? PDF_DEFAULT_MARGIN_INCHES,
        };

        let printed: unknown;

        try {
            printed = await context.access.send(targetId, "Page.printToPDF", {
                landscape        : args.landscape ?? false,
                printBackground  : args.printBackground ?? true,
                scale            : args.scale ?? 1,
                paperWidth       : args.paperWidth ?? PDF_A4_WIDTH_INCHES,
                paperHeight      : args.paperHeight ?? PDF_A4_HEIGHT_INCHES,
                marginTop        : margins.top,
                marginBottom     : margins.bottom,
                marginLeft       : margins.left,
                marginRight      : margins.right,
                ...(args.pageRanges === undefined ? {} : { pageRanges: args.pageRanges }),
                preferCSSPageSize: args.preferCSSPageSize ?? false,
            });
        } catch {
            throw new ToolError(
                "The browser refused to print this tab to PDF. It needs a headless managed browser, or the tab shows a page that cannot be printed.",
            );
        }

        const parsed = pdfSchema.safeParse(printed);

        if (!parsed.success) {
            throw new ToolError(
                "The browser returned an empty PDF. Try the call again or print fewer pages.",
            );
        }

        const bytes = Buffer.from(parsed.data.data, "base64");

        if (bytes.byteLength > maxBytes) {
            const mib = (maxBytes / (1024 * 1024)).toFixed(maxBytes % (1024 * 1024) === 0 ? 0 : 1);

            throw new ToolError(
                `The PDF is larger than the ${mib} MiB limit. Use pageRanges to print fewer pages.`,
            );
        }

        const pages = countPdfPages(bytes);
        const uri = `pdf://${targetId}/${context.clock.now()}`;

        return {
            bytes   : bytes.byteLength,
            ...(pages === undefined ? {} : { pages }),
            uri,
            data    : parsed.data.data,
            mimeType: "application/pdf",
        };
    },
});
