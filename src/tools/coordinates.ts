import type { Rect } from "./element-target.js";
import { ToolError } from "./errors.js";

export interface ClickPoint {
    x: number;
    y: number;
}

export interface ElementOffset {
    x: number;
    y: number;
}

export interface FrameOrigin {
    x: number;
    y: number;
}

export const TOP_LEVEL_ORIGIN: FrameOrigin = { x: 0, y: 0 };

export function centerOf(rect: Rect): ClickPoint {
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);

    return { x, y };
}

export function clickPointOf(
    rect  : Rect,
    offset: ElementOffset | undefined,
    origin: FrameOrigin = TOP_LEVEL_ORIGIN,
): ClickPoint {
    if (rect.width <= 0 || rect.height <= 0) {
        throw new ToolError("The element has no box on the page and cannot receive input.");
    }

    if (offset === undefined) {
        const center = centerOf(rect);

        return { x: center.x + origin.x, y: center.y + origin.y };
    }

    if (
        !Number.isFinite(offset.x) || !Number.isFinite(offset.y) || offset.x < 0 || offset.y < 0 ||
        offset.x > rect.width || offset.y > rect.height
    ) {
        throw new ToolError(
            `The position (${offset.x}, ${offset.y}) lies outside the element box of ${rect.width} by ${rect.height} CSS pixels. Pick a point inside the element.`,
        );
    }

    const x = Math.round(rect.x + offset.x) + origin.x;
    const y = Math.round(rect.y + offset.y) + origin.y;

    return { x, y };
}

export function quadCenter(quad: number[], origin: FrameOrigin = TOP_LEVEL_ORIGIN): ClickPoint {
    const xs = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
    const ys = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0];

    const x = Math.round((Math.min(...xs) + Math.max(...xs)) / 2) + origin.x;
    const y = Math.round((Math.min(...ys) + Math.max(...ys)) / 2) + origin.y;

    return { x, y };
}

export function insideViewport(
    point   : ClickPoint,
    viewport: { width: number; height: number },
): boolean {
    return point.x >= 0 && point.y >= 0 && point.x < viewport.width && point.y < viewport.height;
}
