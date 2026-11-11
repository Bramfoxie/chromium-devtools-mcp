import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { maskImage, passwordNodeIds, pixelBoxes } from "../src/tools/screenshot-mask-image.js";

describe("screenshot password masking", () => {
    it("finds visible password inputs across snapshot documents", () => {
        const nodes = {
            nodeName     : [0, 0, 0], backendNodeId: [1, 2, 3],
            attributes   : [[1, 2], [1, 3], [1, 2]],
        };
        const snapshot = {
            strings  : ["INPUT", "type", "password", "text"],
            documents: [
                { nodes, layout: { nodeIndex: [0, 1] } },
                { nodes: { ...nodes, backendNodeId: [4, 5, 6] }, layout: { nodeIndex: [0] } },
            ],
        };

        expect(passwordNodeIds(snapshot)).toEqual([1, 4]);
    });

    it("rejects incomplete snapshot data", () => {
        expect(() => passwordNodeIds({ strings: [], documents: [{}] })).toThrow("masking");
    });

    it("maps and clips masks to the image", () => {
        expect(pixelBoxes([{ x: 90, y: 50, width: 20, height: 10 }],
            { x: 100, y: 50, width: 100, height: 100 }, { width: 200, height: 200 }))
            .toEqual([{ left: 0, top: 0, width: 22, height: 22 }]);
    });

    it.each(["png", "jpeg", "webp"] as const)("covers pixels in %s images", async (format) => {
        const input = await sharp({
            create: { width: 40, height: 40, channels: 3, background: "white" },
        })
            .toFormat(format).toBuffer();
        const masked = await maskImage(
            input, [{ left: 10, top: 10, width: 20, height: 20 }], format, 100,
        );
        const { data, info } = await sharp(masked).removeAlpha().raw()
            .toBuffer({ resolveWithObject: true });
        const pixel = (x: number, y: number) => data[(y * info.width + x) * info.channels] ?? -1;

        expect(pixel(20, 20)).toBeLessThan(10);
        expect(pixel(2, 2)).toBeGreaterThan(245);
    });
});
