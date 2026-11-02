import { describe, expect, it } from "vitest";
import {
    centerOf,
    clickPointOf,
    ToolError,
} from "../src/tools/index.js";

describe("centerOf", () => {
    it("rounds the rectangle center", () => {
        expect(centerOf({ x: 10, y: 20, width: 21, height: 9 })).toEqual({ x: 21, y: 25 });
    });
});

describe("clickPointOf", () => {
    const rect = { x: 10, y: 20, width: 100, height: 50 };

    it("returns the center without an offset", () => {
        expect(clickPointOf(rect, undefined)).toEqual({ x: 60, y: 45 });
    });

    it("applies an offset relative to the top left corner", () => {
        expect(clickPointOf(rect, { x: 0, y: 0 })).toEqual({ x: 10, y: 20 });
        expect(clickPointOf(rect, { x: 100, y: 50 })).toEqual({ x: 110, y: 70 });
        expect(clickPointOf(rect, { x: 2.4, y: 3.5 })).toEqual({ x: 12, y: 24 });
    });

    it("adds the frame origin of a nested frame", () => {
        expect(clickPointOf(rect, undefined, { x: 5, y: 7 })).toEqual({ x: 65, y: 52 });
        expect(clickPointOf(rect, { x: 1, y: 2 }, { x: 5, y: 7 })).toEqual({ x: 16, y: 29 });
    });

    it("rejects offsets outside the box and boxes without an area", () => {
        const outside = [{ x: -1, y: 0 }, { x: 0, y: -1 }, { x: 101, y: 0 }, { x: 0, y: 51 }];

        for (const offset of outside) expect(() => clickPointOf(rect, offset)).toThrow(ToolError);

        expect(() => clickPointOf(rect, { x: Number.NaN, y: 0 })).toThrow(ToolError);
        expect(() => clickPointOf({ x: 0, y: 0, width: 0, height: 5 }, undefined)).toThrow(
            ToolError,
        );
    });
});
