import { z } from "zod";
import type { ImageSize } from "./image-size.js";

export interface Rect {
    x     : number;
    y     : number;
    width : number;
    height: number;
}

const snapshotSchema = z.object({
    strings  : z.array(z.string()),
    documents: z.array(z.object({
        nodes: z.object({
            nodeName     : z.array(z.number().int().nonnegative()),
            backendNodeId: z.array(z.number().int().positive()),
            attributes   : z.array(z.array(z.number().int().nonnegative()).nullable()),
        }),
        layout: z.object({ nodeIndex: z.array(z.number().int().nonnegative()) }),
    })),
});

const MAX_MASK_NODES = 1000;

export function passwordNodeIds(value: unknown): number[] {
    const parsed = snapshotSchema.safeParse(value);

    if (!parsed.success) throw maskError();

    const { strings, documents } = parsed.data;
    const ids: number[] = [];

    if (documents.length === 0) throw maskError();

    for (const { nodes, layout } of documents) {
        if (nodes.nodeName.length !== nodes.backendNodeId.length ||
            nodes.nodeName.length !== nodes.attributes.length ||
            layout.nodeIndex.some((index) => index >= nodes.nodeName.length)) throw maskError();

        const visible = new Set(layout.nodeIndex);

        for (let index = 0; index < nodes.nodeName.length; index += 1) {
            const nameIndex = nodes.nodeName[index];

            if (nameIndex === undefined || strings[nameIndex] === undefined) throw maskError();
            if (strings[nameIndex]?.toLowerCase() !== "input" || !visible.has(index)) continue;

            const attributes = nodes.attributes[index];
            const id = nodes.backendNodeId[index];

            if (attributes == null || id === undefined || attributes.length % 2 !== 0) {
                throw maskError();
            }

            for (let i = 0; i < attributes.length; i += 2) {
                const key = strings[attributes[i] ?? -1];
                const value = strings[attributes[i + 1] ?? -1];

                if (key === undefined || value === undefined) throw maskError();
                if (key.toLowerCase() === "type" && value.toLowerCase() === "password") ids.push(id);
            }
        }
    }

    if (ids.length > MAX_MASK_NODES) throw maskError();

    return ids;
}

function maskError(): Error {
    return new Error("Password masking could not cover the screenshot.");
}

interface PixelBox { left: number; top: number; width: number; height: number }

export class MaskImageUnavailableError extends Error {}

export function pixelBoxes(boxes: Rect[], capture: Rect, image: ImageSize): PixelBox[] {
    if (capture.width <= 0 || capture.height <= 0 || image.width <= 0 || image.height <= 0) {
        throw maskError();
    }

    return boxes.flatMap((box) => {
        const left = Math.max(0, Math.floor((box.x - capture.x) * image.width / capture.width) - 2);
        const top = Math.max(0,
            Math.floor((box.y - capture.y) * image.height / capture.height) - 2);
        const right = Math.min(image.width,
            Math.ceil((box.x + box.width - capture.x) * image.width / capture.width) + 2);
        const bottom = Math.min(image.height,
            Math.ceil((box.y + box.height - capture.y) * image.height / capture.height) + 2);

        return right > left && bottom > top
            ? [{ left, top, width: right - left, height: bottom - top }]
            : [];
    });
}

export async function maskImage(
    bytes: Buffer, boxes: PixelBox[], format: "png" | "jpeg" | "webp", quality: number | undefined,
): Promise<Buffer> {
    if (boxes.length === 0) return bytes;

    let sharp: typeof import("sharp")["default"];

    try {
        sharp = (await import("sharp")).default;
    } catch {
        throw new MaskImageUnavailableError("The image library is unavailable.");
    }

    const image = sharp(bytes).composite(boxes.map((box) => ({
        input: { create: { width: box.width, height: box.height, channels: 3, background: "#000000" } },
        left : box.left, top  : box.top,
    })));

    if (format === "png") return image.png().toBuffer();
    if (format === "webp") return image.webp({ quality: quality ?? 80 }).toBuffer();

    return image.jpeg({ quality: quality ?? 80 }).toBuffer();
}
