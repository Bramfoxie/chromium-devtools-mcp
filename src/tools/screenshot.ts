import { z } from "zod";
import { ErrorCode, RpcError } from "../daemon/index.js";
import type { DaemonAccess } from "../mcp/index.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import {
    type ElementTarget,
    boxOf,
    elementAccess,
    elementTargetSchema,
    withElement,
    revealElement,
} from "./element-target.js";
import { ToolError } from "./errors.js";
import { holdRendering } from "./hold-rendering.js";
import { frameChain, mapRect, measureChain, revealChain, settleRendering } from "./frame-geometry.js";
import { type ImageSize, imageSize } from "./image-size.js";
import { binaryResult, imageBlock } from "./result.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const SCREENSHOT_DEFAULT_QUALITY = 80;

const SCREENSHOT_RETRY_QUALITY = 30;

const SCREENSHOT_FIRST_ATTEMPT_MS = 5000;

const SCREENSHOT_DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

const SCREENSHOT_MAX_BYTES_LIMIT = 16 * 1024 * 1024;

const SCREENSHOT_DEFAULT_MAX_DIMENSION = 4096;

type ScreenshotFormat = "png" | "jpeg" | "webp";

const MIME_OF: Record<ScreenshotFormat, string> = {
    png : "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp",
};

interface ScreenshotClip {
    x     : number;
    y     : number;
    width : number;
    height: number;
}

interface ScreenshotPlan {
    clip      : ScreenshotClip | undefined;
    scale     : number | undefined;
    clipped   : boolean;
    scaledDown: boolean;
}

const clipSchema = z.strictObject({
    x     : z.number().min(0).max(100000),
    y     : z.number().min(0).max(100000),
    width : z.number().min(1).max(100000),
    height: z.number().min(1).max(100000),
});

const capturedSchema = z.object({ data: z.string().min(1) });

const viewportSchema = z.object({
    pageX       : z.number().optional(),
    pageY       : z.number().optional(),
    clientWidth : z.number(),
    clientHeight: z.number(),
});

const contentSchema = z.object({ width: z.number(), height: z.number() });

const layoutSchema = z.object({
    layoutViewport   : viewportSchema,
    cssLayoutViewport: viewportSchema.optional(),
    contentSize      : contentSchema.optional(),
    cssContentSize   : contentSchema.optional(),
});

interface PageLayout {
    viewport?: ScreenshotClip;
    content? : ImageSize;
}

export function roundClip(clip: ScreenshotClip): ScreenshotClip {
    return {
        x     : Math.max(0, Math.floor(clip.x)),
        y     : Math.max(0, Math.floor(clip.y)),
        width : Math.max(1, Math.ceil(clip.width)),
        height: Math.max(1, Math.ceil(clip.height)),
    };
}

export function planScreenshot(args: {
    fullPage?   : boolean | undefined;
    clip?       : ScreenshotClip | undefined;
    targetBox?  : ScreenshotClip | undefined;
    scale?      : number | undefined;
    viewport?   : ScreenshotClip | undefined;
    content?    : ImageSize | undefined;
    maxDimension: number;
}): ScreenshotPlan {
    const scale = args.scale ?? 1;
    const box = args.targetBox ?? args.clip;

    if (box !== undefined) return planClip(roundClip(box), scale, args.maxDimension, true);

    if (args.fullPage === true) {
        if (args.content !== undefined && args.content.width > 0 && args.content.height > 0) {
            const whole = roundClip({ x: 0, y: 0, ...args.content });

            return planClip(whole, scale, args.maxDimension, false);
        }

        if (scale !== 1) throw unknownSizeError();

        return { clip: undefined, scale: undefined, clipped: false, scaledDown: false };
    }

    if (args.viewport === undefined || args.viewport.width <= 0 || args.viewport.height <= 0) {
        if (scale !== 1) throw unknownSizeError();

        return { clip: undefined, scale: undefined, clipped: false, scaledDown: false };
    }

    const plan = planClip(roundClip(args.viewport), scale, args.maxDimension, false);

    return plan.scale === undefined ? { ...plan, clip: undefined } : plan;
}

function planClip(
    clip        : ScreenshotClip,
    scale       : number,
    maxDimension: number,
    clipped     : boolean,
): ScreenshotPlan {
    const longest = Math.max(clip.width, clip.height);
    const fit = longest > maxDimension ? maxDimension / longest : 1;
    const effective = Math.min(scale, fit);

    return {
        clip,
        scale     : effective === 1 ? undefined : effective,
        clipped,
        scaledDown: effective < 1,
    };
}

function unknownSizeError(): ToolError {
    return new ToolError(
        "The browser did not report the viewport size, so scale cannot be applied. Capture without scale or pass an explicit clip.",
    );
}

export function retryQuality(quality: number): number {
    return Math.min(quality, SCREENSHOT_RETRY_QUALITY);
}

async function layoutOf(access: DaemonAccess, tab: string): Promise<PageLayout> {
    try {
        const layout = layoutSchema.safeParse(await access.send(tab, "Page.getLayoutMetrics", {}));

        if (!layout.success) return {};

        const viewport = layout.data.cssLayoutViewport ?? layout.data.layoutViewport;
        const content = layout.data.cssContentSize ?? layout.data.contentSize;

        return {
            viewport: {
                x     : viewport.pageX ?? 0,
                y     : viewport.pageY ?? 0,
                width : viewport.clientWidth,
                height: viewport.clientHeight,
            },
            ...(content === undefined ? {} : { content }),
        };
    } catch {
        return {};
    }
}

async function targetBoxOf(
    context: ToolContext,
    tab    : string,
    target : ElementTarget,
): Promise<ScreenshotClip> {
    return withElement(context, tab, target, async (element) => {
        const owner = elementAccess(context.access, element);
        const revealed = await revealElement(owner, tab, { objectId: element.objectId });
        const measured = revealed.box === null
            ? await boxOf(owner, tab, { objectId: element.objectId })
            : revealed;

        if (measured.box === null || !measured.visible) {
            throw new ToolError(
                "The element has no visible box to capture. Check that it is rendered.",
            );
        }

        if (element.isolated !== true || element.frameId === undefined) return measured.box;

        const chain = await frameChain(context.access, context.frames, tab, element.frameId);

        await revealChain(chain, tab, measured.box);
        await settleRendering(
            [context.access, ...chain.links.map((link) => link.access), owner],
            tab,
        );

        return mapRect((await measureChain(chain, tab)).toTop, measured.box);
    });
}

interface CaptureRequest {
    format               : ScreenshotFormat;
    quality?             : number;
    captureBeyondViewport: boolean;
    clip?                : ScreenshotClip;
    scale?               : number;
}

async function capture(
    access : DaemonAccess,
    tab    : string,
    request: CaptureRequest,
): Promise<string> {
    const params = {
        format: request.format,
        ...(request.quality === undefined ? {} : { quality: request.quality }),
        ...(request.clip === undefined ? {} : {
            clip: { ...request.clip, scale: request.scale ?? 1 },
        }),
        captureBeyondViewport: request.captureBeyondViewport,
        fromSurface          : true,
    };
    const result = capturedSchema.safeParse(await sendCapture(access, tab, params));

    if (!result.success) {
        throw new ToolError(
            "The browser returned an empty screenshot. The tab may be showing a privileged page; navigate elsewhere and try again.",
        );
    }

    return result.data.data;
}

async function sendCapture(
    access: DaemonAccess,
    tab   : string,
    params: Record<string, unknown>,
): Promise<unknown> {
    try {
        return await access.send(tab, "Page.captureScreenshot", params, SCREENSHOT_FIRST_ATTEMPT_MS);
    } catch (error) {
        if (!(error instanceof RpcError) || error.code !== ErrorCode.cdpTimeout) throw error;

        return access.send(tab, "Page.captureScreenshot", params);
    }
}

export function formatByteLimit(maxBytes: number): string {
    if (maxBytes % (1024 * 1024) === 0) return `${maxBytes / (1024 * 1024)} MiB`;
    if (maxBytes % 1024 === 0) return `${maxBytes / 1024} KiB`;

    return `${maxBytes} bytes`;
}

function oversizeError(maxBytes: number): ToolError {
    return new ToolError(
        `The screenshot is larger than the ${formatByteLimit(maxBytes)} limit. Use format jpeg, a smaller clip or a scale below 1.`,
    );
}

const screenshotSmall = z.strictObject({
    width     : z.number().describe("Image width in pixels."),
    height    : z.number().describe("Image height in pixels."),
    bytes     : z.number().describe("Image size in bytes."),
    format    : z.enum(["png", "jpeg", "webp"]).describe("Image format."),
    clipped   : z.boolean().describe("Whether the shot is clipped to an element or a rectangle."),
    scaledDown: z.boolean().describe("Whether the shot was scaled below full size."),
});

const screenshotOutput = screenshotSmall.extend({
    data    : z.string().describe("Base64 encoded image, presented as an image block."),
    mimeType: z.string().describe("MIME type of the image."),
});

export const screenshot = defineTool({
    name: "screenshot",
    description:
        "Capture a tab as an image. Defaults to jpeg quality 80 to keep outputs small; works on background tabs without focusing them.",
    access: (args: unknown) =>
        (args as { target?: unknown } | null)?.target === undefined ? "read" : "mutate",
    input: z.strictObject({
        tab         : tabSchema,
        format      : z.enum(["png", "jpeg", "webp"]).optional().describe("Image format. Defaults to jpeg."),
        quality     : z.number().int().min(1).max(100).optional().describe("Quality for jpeg and webp. Defaults to 80."),
        fullPage    : z.boolean().optional().describe("Capture beyond the viewport. Defaults to false."),
        target      : elementTargetSchema.optional().describe("Clip to this element after scrolling it into view."),
        clip        : clipSchema.optional().describe("Clip to this CSS rectangle in page coordinates measured from the document origin. Rejected together with target."),
        scale       : z.number().min(0.1).max(2).optional().describe("Scale factor. Defaults to 1."),
        maxBytes    : z.number().int().min(1024).max(SCREENSHOT_MAX_BYTES_LIMIT).optional().describe("Maximum image bytes. Defaults to 4 MiB."),
        maxDimension: z.number().int().min(64).max(16384).optional().describe("Clamp the longest side to this many pixels. Defaults to 4096."),
    }).superRefine((value, ctx) => {
        if (value.target !== undefined && value.clip !== undefined) {
            ctx.addIssue({ code: "custom", message: "Pass target or clip, not both." });
        }

        if (value.format === "png" && value.quality !== undefined) {
            ctx.addIssue({ code: "custom", message: "Quality applies to jpeg and webp only." });
        }
    }),
    output   : screenshotOutput,
    announced: screenshotSmall,
    present  : (output) => {
        const { data, mimeType, ...small } = output;

        return binaryResult(small, imageBlock({ data, mimeType }));
    },
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);

        return holdRendering(context.access, targetId, async () => {
            const format = args.format ?? "jpeg";
            const quality = args.quality ?? (format === "png" ? undefined : SCREENSHOT_DEFAULT_QUALITY);
            const maxBytes = args.maxBytes ?? SCREENSHOT_DEFAULT_MAX_BYTES;
            const maxDimension = args.maxDimension ?? SCREENSHOT_DEFAULT_MAX_DIMENSION;

            const targetBox = args.target === undefined
                ? undefined
                : await targetBoxOf(context, targetId, args.target);
            const layout = await layoutOf(context.access, targetId);
            const pageBox = targetBox === undefined || layout.viewport === undefined
                ? targetBox
                : {
                    ...targetBox,
                    x: targetBox.x + layout.viewport.x,
                    y: targetBox.y + layout.viewport.y,
                };
            const plan = planScreenshot({
                fullPage : args.fullPage,
                clip     : args.clip,
                targetBox: pageBox,
                scale    : args.scale,
                viewport : layout.viewport,
                content  : layout.content,
                maxDimension,
            });

            const shot = await shoot(context, targetId, {
                format,
                quality,
                captureBeyondViewport: args.fullPage ?? false,
                clip                 : plan.clip,
                scale                : plan.scale,
                maxBytes,
                explicitPng          : args.format === "png",
            });
            const bytes = Buffer.from(shot, "base64");
            const size = imageSize(format, bytes);

            return {
                width     : size?.width ?? 0,
                height    : size?.height ?? 0,
                bytes     : bytes.byteLength,
                format,
                clipped   : plan.clipped,
                scaledDown: plan.scaledDown,
                data      : shot,
                mimeType  : MIME_OF[format],
            };
        });
    },
});

interface ShotRequest extends CaptureRequest {
    maxBytes   : number;
    explicitPng: boolean;
}

async function shoot(context: ToolContext, tab: string, request: ShotRequest): Promise<string> {
    const data = await capture(context.access, tab, request);

    if (Buffer.byteLength(data, "base64") <= request.maxBytes) return data;

    if (request.format === "png" || request.quality === undefined) throw oversizeError(request.maxBytes);

    const lower = retryQuality(request.quality);

    if (lower >= request.quality) throw oversizeError(request.maxBytes);

    const second = await capture(context.access, tab, { ...request, quality: lower });

    if (Buffer.byteLength(second, "base64") <= request.maxBytes) return second;

    throw oversizeError(request.maxBytes);
}
