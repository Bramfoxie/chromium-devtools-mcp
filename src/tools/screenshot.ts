import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { defineTool, type ToolContext } from "./define-tool.js";
import {
    type ElementRegistry,
    type ElementTarget,
    boxOf,
    elementTargetSchema,
    resolveElement,
    revealElement,
} from "./element-target.js";
import { ToolError } from "./errors.js";
import { type ImageSize, imageSize } from "./image-size.js";
import { binaryResult, imageBlock } from "./result.js";

export const SCREENSHOT_DEFAULT_QUALITY = 80;

export const SCREENSHOT_RETRY_QUALITY = 30;

export const SCREENSHOT_DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export const SCREENSHOT_MAX_BYTES_LIMIT = 16 * 1024 * 1024;

export const SCREENSHOT_DEFAULT_MAX_DIMENSION = 4096;

export type ScreenshotFormat = "png" | "jpeg" | "webp";

const MIME_OF: Record<ScreenshotFormat, string> = {
    png : "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp",
};

export interface ScreenshotClip {
    x     : number;
    y     : number;
    width : number;
    height: number;
}

export interface ScreenshotPlan {
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

const layoutSchema = z.object({
    layoutViewport: z.object({ clientWidth: z.number(), clientHeight: z.number() }),
});

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
    viewport?   : { width: number; height: number } | undefined;
    maxDimension: number;
}): ScreenshotPlan {
    const scale = args.scale ?? 1;
    const box = args.targetBox ?? args.clip;

    if (box !== undefined) {
        const clip = roundClip(box);
        const longest = Math.max(clip.width, clip.height);
        const fit = longest > args.maxDimension ? args.maxDimension / longest : 1;
        const effective = Math.min(scale, fit);

        return {
            clip,
            scale     : effective === 1 ? undefined : effective,
            clipped   : true,
            scaledDown: effective < 1,
        };
    }

    if (scale !== 1 || args.viewport !== undefined) {
        const viewport = args.viewport ?? { width: 0, height: 0 };

        if (viewport.width <= 0 || viewport.height <= 0) {
            return { clip: undefined, scale: undefined, clipped: false, scaledDown: false };
        }

        const longest = Math.max(viewport.width, viewport.height);
        const fit = longest > args.maxDimension ? args.maxDimension / longest : 1;
        const effective = Math.min(scale, fit);

        return {
            clip      : roundClip({ x: 0, y: 0, width: viewport.width, height: viewport.height }),
            scale     : effective === 1 ? undefined : effective,
            clipped   : false,
            scaledDown: effective < 1,
        };
    }

    return { clip: undefined, scale: undefined, clipped: false, scaledDown: false };
}

export function retryQuality(quality: number): number {
    return Math.min(quality, SCREENSHOT_RETRY_QUALITY);
}

async function viewportOf(access: DaemonAccess, tab: string): Promise<ImageSize | undefined> {
    try {
        const layout = layoutSchema.safeParse(await access.send(tab, "Page.getLayoutMetrics", {}));

        if (!layout.success) return undefined;

        return {
            width : layout.data.layoutViewport.clientWidth,
            height: layout.data.layoutViewport.clientHeight,
        };
    } catch {
        return undefined;
    }
}

async function targetBoxOf(
    access  : DaemonAccess,
    elements: ElementRegistry,
    tab     : string,
    target  : ElementTarget,
): Promise<ScreenshotClip> {
    const element = await resolveElement(access, elements, tab, target);
    const revealed = await revealElement(access, tab, { objectId: element.objectId });
    const measured = revealed.box === null
        ? await boxOf(access, tab, { objectId: element.objectId })
        : revealed;

    if (measured.box === null || !measured.visible) {
        throw new ToolError("The element has no visible box to capture. Check that it is rendered.");
    }

    return measured.box;
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
    const result = capturedSchema.safeParse(
        await access.send(tab, "Page.captureScreenshot", {
            format: request.format,
            ...(request.quality === undefined ? {} : { quality: request.quality }),
            ...(request.clip === undefined ? {} : {
                clip: {
                    ...request.clip,
                    ...(request.scale === undefined ? {} : { scale: request.scale }),
                },
            }),
            captureBeyondViewport: request.captureBeyondViewport,
            fromSurface          : true,
        }),
    );

    if (!result.success) {
        throw new ToolError(
            "The browser returned an empty screenshot. The tab may be showing a privileged page; navigate elsewhere and try again.",
        );
    }

    return result.data.data;
}

function oversizeError(maxBytes: number): ToolError {
    const mib = (maxBytes / (1024 * 1024)).toFixed(maxBytes % (1024 * 1024) === 0 ? 0 : 1);

    return new ToolError(
        `The screenshot is larger than the ${mib} MiB limit. Use format jpeg, a smaller clip or a scale below 1.`,
    );
}

const screenshotOutput = z.strictObject({
    width     : z.number().describe("Image width in pixels."),
    height    : z.number().describe("Image height in pixels."),
    bytes     : z.number().describe("Image size in bytes."),
    format    : z.enum(["png", "jpeg", "webp"]).describe("Image format."),
    clipped   : z.boolean().describe("Whether the shot is clipped to an element or a rectangle."),
    scaledDown: z.boolean().describe("Whether the shot was scaled below full size."),
    data      : z.string().describe("Base64 encoded image, presented as an image block."),
    mimeType  : z.string().describe("MIME type of the image."),
});

export const screenshot = defineTool({
    name: "screenshot",
    description:
        "Capture a tab as an image. Defaults to jpeg quality 80 to keep outputs small; works on background tabs without focusing them.",
    access: "read",
    input : z.strictObject({
        tab         : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        format      : z.enum(["png", "jpeg", "webp"]).optional().describe("Image format. Defaults to jpeg."),
        quality     : z.number().int().min(1).max(100).optional().describe("Quality for jpeg and webp. Defaults to 80."),
        fullPage    : z.boolean().optional().describe("Capture beyond the viewport. Defaults to false."),
        target      : elementTargetSchema.optional().describe("Clip to this element after scrolling it into view."),
        clip        : clipSchema.optional().describe("Clip to this CSS rectangle. Rejected together with target."),
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
    output : screenshotOutput,
    present: (output) => {
        const { data, mimeType, ...small } = output;

        return binaryResult(small, imageBlock({ data, mimeType }));
    },
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        const format = args.format ?? "jpeg";
        const quality = args.quality ?? (format === "png" ? undefined : SCREENSHOT_DEFAULT_QUALITY);
        const maxBytes = args.maxBytes ?? SCREENSHOT_DEFAULT_MAX_BYTES;
        const maxDimension = args.maxDimension ?? SCREENSHOT_DEFAULT_MAX_DIMENSION;

        const targetBox = args.target === undefined
            ? undefined
            : await targetBoxOf(context.access, context.elements, targetId, args.target);
        const viewport = targetBox !== undefined || args.clip !== undefined
            ? undefined
            : await viewportOf(context.access, targetId);
        const plan = planScreenshot({
            fullPage: args.fullPage,
            clip    : args.clip,
            targetBox,
            scale   : args.scale,
            viewport: viewport === undefined ? undefined : { ...viewport },
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
