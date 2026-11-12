import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
    vi.doUnmock("sharp");
    vi.resetModules();
});

it("loads without the image library and reports its absence only when masking", async () => {
    vi.resetModules();
    vi.doMock("sharp", () => { throw new Error("native library unavailable"); });
    const { screenshot } = await import("../src/tools/index.js");
    const { passwordNodeIds, maskImage } = await import("../src/tools/screenshot-mask-image.js");

    expect(screenshot.name).toBe("screenshot");
    expect(passwordNodeIds({
        strings  : ["DIV"], documents: [{
            nodes : { nodeName: [0], backendNodeId: [1], attributes: [[]] },
            layout: { nodeIndex: [0] },
        }],
    })).toEqual([]);
    await expect(maskImage(Buffer.from("image"), [{ left: 0, top: 0, width: 1, height: 1 }],
        "png", undefined)).rejects.toThrow("image library is unavailable");
});
