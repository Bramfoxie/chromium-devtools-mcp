import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
    imageSize,
    newTab,
    planScreenshot,
    retryQuality,
    roundClip,
    runTool,
    screenshot,
    ToolRuntime,
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

const PNG_2X3 = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00,
]);

const JPEG_5X7 = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x07, 0x00, 0x05, 0x01, 0x01, 0x11,
    0x00,
]);

const WEBP_LOSSY_9X4 = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x1e, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
    0x12, 0x00, 0x00, 0x00, 0x30, 0x29, 0x05, 0x9d, 0x01, 0x2a, 0x09, 0x00, 0x04, 0x00, 0x00, 0x00,
    0x00, 0x00,
]);

const WEBP_LOSSLESS_2X1 = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
    0x0a, 0x00, 0x00, 0x00, 0x2f, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

const WEBP_EXTENDED_3X6 = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58,
    0x0a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x05, 0x00, 0x00,
]);

describe("imageSize", () => {
    it("reads png, jpeg and webp dimensions", () => {
        expect(imageSize("png", PNG_2X3)).toEqual({ width: 2, height: 3 });
        expect(imageSize("jpeg", JPEG_5X7)).toEqual({ width: 5, height: 7 });
        expect(imageSize("webp", WEBP_LOSSY_9X4)).toEqual({ width: 9, height: 4 });
        expect(imageSize("webp", WEBP_LOSSLESS_2X1)).toEqual({ width: 2, height: 1 });
        expect(imageSize("webp", WEBP_EXTENDED_3X6)).toEqual({ width: 3, height: 6 });
    });

    it("rejects truncated and foreign bytes", () => {
        expect(imageSize("png", PNG_2X3.subarray(0, 10))).toBeUndefined();
        expect(imageSize("png", JPEG_5X7)).toBeUndefined();
        expect(imageSize("jpeg", PNG_2X3)).toBeUndefined();
        expect(imageSize("jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined();
        expect(imageSize("webp", PNG_2X3)).toBeUndefined();
    });
});

describe("planScreenshot", () => {
    it("rounds clips and clamps the longest side", () => {
        expect(roundClip({ x: 1.7, y: 2.2, width: 10.2, height: 0.4 })).toEqual({
            x     : 1,
            y     : 2,
            width : 11,
            height: 1,
        });
        expect(
            planScreenshot({ clip: { x: 0, y: 0, width: 8000, height: 100 }, maxDimension: 4096 }),
        ).toMatchObject({ clipped: true, scaledDown: true, scale: 0.512 });
        expect(planScreenshot({ maxDimension: 4096 })).toEqual({
            clip      : undefined,
            scale     : undefined,
            clipped   : false,
            scaledDown: false,
        });
        const scaled = planScreenshot({
            scale       : 0.5,
            viewport    : { width: 100, height: 50 },
            maxDimension: 4096,
        });

        expect(scaled).toMatchObject({ clipped: false, scaledDown: true, scale: 0.5 });
    });

    it("prefers the element box and degrades without a viewport", () => {
        const plan = planScreenshot({
            targetBox   : { x: 0, y: 0, width: 10, height: 10 },
            clip        : { x: 5, y: 5, width: 20, height: 20 },
            maxDimension: 4096,
        });

        expect(plan.clip).toMatchObject({ width: 10, height: 10 });
        expect(planScreenshot({ scale: 0.5, maxDimension: 4096 }).clip).toBeUndefined();
    });

    it("derives the retry quality", () => {
        expect(retryQuality(80)).toBe(30);
        expect(retryQuality(20)).toBe(20);
    });
});

describe("screenshot", () => {
    function shotFake(data: string, onCapture?: (params: Record<string, unknown>) => void) {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method, params) => {
            if (method === "Page.captureScreenshot") {
                onCapture?.(params ?? {});

                return { data };
            }

            if (method === "Page.getLayoutMetrics") {
                return { layoutViewport: { clientWidth: 1280, clientHeight: 720 } };
            }

            return {};
        };

        return fake;
    }

    it("captures the viewport as jpeg by default with an image block", async () => {
        const seen: unknown[] = [];
        const shot = shotFake(JPEG_5X7.toString("base64"), (params) => void seen.push(params));
        const { runtime } = setup(shot);

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(screenshot, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({
            width     : 5,
            height    : 7,
            bytes     : JPEG_5X7.byteLength,
            format    : "jpeg",
            clipped   : false,
            scaledDown: false,
        });
        expect(result.content).toHaveLength(2);
        expect(result.content[1]).toMatchObject({
            type    : "image",
            mimeType: "image/jpeg",
            data    : JPEG_5X7.toString("base64"),
        });
        expect(seen[0]).toMatchObject({
            format               : "jpeg",
            quality              : 80,
            captureBeyondViewport: false,
            fromSurface          : true,
        });
        expect(screenshot.announced?.safeParse(result.structuredContent).success).toBe(true);
    });

    it("captures full page and explicit clips with scale", async () => {
        const seen: Array<Record<string, unknown>> = [];
        const { runtime } = setup(
            shotFake(PNG_2X3.toString("base64"), (params) => void seen.push(params)),
        );

        await runTool(newTab, {}, extra(), runtime);
        const full = await runTool(screenshot, { format: "png", fullPage: true }, extra(), runtime);

        expect(full.structuredContent).toMatchObject({ format: "png", width: 2, height: 3 });
        expect(seen[0]).toMatchObject({ format: "png", captureBeyondViewport: true });
        expect(seen[0]).not.toHaveProperty("quality");

        await runTool(
            screenshot,
            { clip: { x: 10, y: 20, width: 100, height: 50 }, scale: 0.5 },
            extra(),
            runtime,
        );
        expect(seen[1]).toMatchObject({
            clip: { x: 10, y: 20, width: 100, height: 50, scale: 0.5 },
        });
    });

    it("clips to an element box after scrolling it into view", async () => {
        const fake = shotFake(PNG_2X3.toString("base64"));
        const calls: string[] = [];
        const respond = fake.respond;

        fake.respond = (targetId, method, params) => {
            calls.push(method);

            if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
            if (method === "DOM.querySelector") return { nodeId: 9 };
            if (method === "DOM.resolveNode") return { object: { objectId: "obj-9" } };
            if (method === "DOM.describeNode") return { node: { backendNodeId: 9 } };
            if (method === "DOM.scrollIntoViewIfNeeded") return {};

            if (method === "DOM.getBoxModel") {
                return {
                    model: {
                        content: [1, 2, 11, 2, 11, 8, 1, 8],
                        padding: [1, 2, 11, 2, 11, 8, 1, 8],
                        border : [1, 2, 11, 2, 11, 8, 1, 8],
                        margin : [1, 2, 11, 2, 11, 8, 1, 8],
                    },
                };
            }

            return respond?.(targetId, method, params);
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(screenshot, { target: { selector: "h1" } }, extra(), runtime);
        const shot = fake.sent.find((call) => call.method === "Page.captureScreenshot");

        expect(result.structuredContent).toMatchObject({ clipped: true });
        expect(shot?.params).toMatchObject({ clip: { x: 1, y: 2, width: 10, height: 6 } });
        expect(calls).toContain("DOM.scrollIntoViewIfNeeded");
    });

    it("retries once with a lower quality when over the limit", async () => {
        const qualities: unknown[] = [];
        const big = Buffer.alloc(3000, 7).toString("base64");
        const small = Buffer.alloc(500, 7).toString("base64");
        let calls = 0;
        const fake = new FakeAccess();

        fake.respond = (_targetId, method, params) => {
            if (method === "Page.captureScreenshot") {
                calls += 1;
                qualities.push((params as { quality?: unknown } | undefined)?.quality);

                return { data: calls === 1 ? big : small };
            }

            if (method === "Page.getLayoutMetrics") {
                return { layoutViewport: { clientWidth: 100, clientHeight: 100 } };
            }

            return {};
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(screenshot, { maxBytes: 1024 }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(qualities).toEqual([80, 30]);
        expect((result.structuredContent as { bytes: number }).bytes).toBe(500);
    });

    it("fails a stubborn oversize with a remedy and never switches an explicit png", async () => {
        const big = Buffer.alloc(3000, 7).toString("base64");
        const { runtime } = setup(shotFake(big));

        await runTool(newTab, {}, extra(), runtime);

        const jpeg = await runTool(screenshot, { maxBytes: 1024 }, extra(), runtime);

        expect(jpeg.isError).toBe(true);
        expect(JSON.stringify(jpeg.content)).toContain("smaller clip");

        const png = await runTool(screenshot, { format: "png", maxBytes: 1024 }, extra(), runtime);

        expect(png.isError).toBe(true);
        expect(JSON.stringify(png.content)).toContain("format jpeg");
    });

    it("rejects target with clip, png quality and empty shots", async () => {
        const { runtime } = setup(shotFake(""));

        await runTool(newTab, {}, extra(), runtime);

        const both = await runTool(
            screenshot,
            { target: { selector: "h1" }, clip: { x: 0, y: 0, width: 1, height: 1 } },
            extra(),
            runtime,
        );

        expect(both.isError).toBe(true);

        const quality = await runTool(screenshot, { format: "png", quality: 50 }, extra(), runtime);

        expect(quality.isError).toBe(true);

        const empty = await runTool(screenshot, {}, extra(), runtime);

        expect(empty.isError).toBe(true);
        expect(JSON.stringify(empty.content)).toContain("empty screenshot");
    });

    it("names new_tab without a selection", async () => {
        const { runtime } = setup();
        const result = await runTool(screenshot, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("new_tab");
    });
});
