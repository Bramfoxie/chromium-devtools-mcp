import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import {
    countPdfPages,
    newTab,
    pagePdf,
    runTool,
    ToolRuntime,
    validPageRanges,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

function setup(access?: FakeAccess) {
    const fake = access ?? new FakeAccess();
    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

    return { fake, runtime };
}

const TWO_PAGE_PDF = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
        "2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj\n" +
        "3 0 obj<</Type/Page/Parent 2 0 R>>endobj\n" +
        "4 0 obj<</Type/Page/Parent 2 0 R>>endobj\n",
    "latin1",
);

describe("pdf helpers", () => {
    it("validates page ranges", () => {
        expect(validPageRanges("1-3,5")).toBe(true);
        expect(validPageRanges("2")).toBe(true);
        expect(validPageRanges("3-1")).toBe(false);
        expect(validPageRanges("0")).toBe(false);
        expect(validPageRanges("1-")).toBe(false);
        expect(validPageRanges("a-b")).toBe(false);
        expect(validPageRanges("")).toBe(false);
    });

    it("counts pages from uncompressed objects", () => {
        expect(countPdfPages(TWO_PAGE_PDF)).toBe(2);
        expect(countPdfPages(Buffer.from("%PDF-1.4\n", "latin1"))).toBeUndefined();
    });
});

describe("page_pdf", () => {
    function pdfFake(data: string, onPrint?: (params: Record<string, unknown>) => void) {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method, params) => {
            if (method === "Page.printToPDF") {
                onPrint?.(params ?? {});

                return { data };
            }

            return {};
        };

        return fake;
    }

    it("prints with defaults and returns a resource block", async () => {
        const seen: unknown[] = [];
        const { runtime } = setup(
            pdfFake(TWO_PAGE_PDF.toString("base64"), (params) => void seen.push(params)),
        );

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(pagePdf, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            bytes: TWO_PAGE_PDF.byteLength,
            pages: 2,
            uri  : expect.stringMatching(/^pdf:\/\/tab1\/\d+$/),
        });
        expect(result.content).toHaveLength(2);
        expect(result.content[1]).toMatchObject({
            type    : "resource",
            resource: {
                mimeType: "application/pdf",
                blob    : TWO_PAGE_PDF.toString("base64"),
            },
        });
        expect(seen[0]).toMatchObject({
            landscape        : false,
            printBackground  : true,
            scale            : 1,
            paperWidth       : 8.27,
            paperHeight      : 11.69,
            marginTop        : 0.4,
            marginBottom     : 0.4,
            marginLeft       : 0.4,
            marginRight      : 0.4,
            preferCSSPageSize: false,
        });
    });

    it("passes ranges, orientation and margins through", async () => {
        const seen: Array<Record<string, unknown>> = [];
        const { runtime } = setup(
            pdfFake(TWO_PAGE_PDF.toString("base64"), (params) => void seen.push(params)),
        );

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(
            pagePdf,
            {
                landscape : true,
                pageRanges: "1",
                margins   : { top: 1, left: 0.5 },
                scale     : 0.8,
            },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(seen[0]).toMatchObject({
            landscape : true,
            pageRanges: "1",
            marginTop : 1,
            marginLeft: 0.5,
            scale     : 0.8,
        });
    });

    it("refuses oversize results with the remedy and bad ranges", async () => {
        const big = Buffer.alloc(3000, 9).toString("base64");
        const { runtime } = setup(pdfFake(big));

        await runTool(newTab, {}, extra(), runtime);

        const large = await runTool(pagePdf, { maxBytes: 1024 }, extra(), runtime);

        expect(large.isError).toBe(true);
        expect(JSON.stringify(large.content)).toContain("pageRanges");

        const ranges = await runTool(pagePdf, { pageRanges: "3-1" }, extra(), runtime);

        expect(ranges.isError).toBe(true);
    });

    it("maps a browser refusal to the headless remedy", async () => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) => {
            if (method === "Page.printToPDF") {
                throw new RpcError(ErrorCode.cdpError, "PrintToPDF is not implemented");
            }

            return {};
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(pagePdf, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("headless managed browser");
    });

    it("names new_tab without a selection", async () => {
        const { runtime } = setup();
        const result = await runTool(pagePdf, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("new_tab");
    });
});
