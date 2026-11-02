import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import { FrameState, ToolError } from "../src/tools/index.js";
import {
    composeTransform,
    frameChain,
    IDENTITY_TRANSFORM,
    mapPoint,
    mapRect,
    measureChain,
    outerHitTest,
    ownerGeometry,
    revealChain,
    settleRendering,
} from "../src/tools/frame-geometry.js";
import { FakeAccess } from "./helpers/fake-access.js";

const PLAIN_OWNER = {
    content: [62, 132, 362, 132, 362, 332, 62, 332],
    border : [50, 120, 374, 120, 374, 344, 50, 344],
    width  : 324,
    height : 224,
};

const SCALED_OWNER = {
    content: [56, 126, 206, 126, 206, 226, 56, 226],
    border : [50, 120, 212, 120, 212, 232, 50, 232],
    width  : 324,
    height : 224,
};

const NESTED_OWNER = {
    content: [103, 93, 253, 93, 253, 173, 103, 173],
    border : [100, 90, 256, 90, 256, 176, 100, 176],
    width  : 156,
    height : 86,
};

function model(owner: typeof PLAIN_OWNER): unknown {
    return { model: { ...owner, padding: owner.content, margin: owner.border } };
}

function crossFake(): FakeAccess {
    const fake = new FakeAccess();

    fake.frames = [
        { frameId: "main", url: "http://a/", name: "", isolated: false },
        { frameId: "mid", parentFrameId: "main", url: "http://b/", name: "", isolated: true },
        { frameId: "deep", parentFrameId: "mid", url: "http://a/d", name: "", isolated: true },
        { frameId: "same", parentFrameId: "main", url: "http://a/s", name: "", isolated: false },
    ];

    fake.respond = (_tab, method, params) => {
        const session = fake.sent.at(-1)?.frameId;
        const nodeId = (params as { backendNodeId?: unknown } | undefined)?.backendNodeId;

        switch (method) {
            case "DOM.getFrameOwner":
                return { backendNodeId: session === undefined ? 6 : 4, nodeId: 1 };
            case "DOM.getBoxModel":
                return model(nodeId === 6 ? PLAIN_OWNER : NESTED_OWNER);
            case "DOM.scrollIntoViewIfNeeded":
                return {};
            default:
                throw new Error(`unexpected CDP call ${method}`);
        }
    };

    return fake;
}

function framesOf(fake: FakeAccess): FrameState {
    return new FrameState({ access: fake.asAccess() });
}

describe("transforms", () => {
    it("composes an inner frame into an outer frame", () => {
        const outer = { x: 62, y: 132, scaleX: 1, scaleY: 1 };
        const inner = { x: 103, y: 93, scaleX: 1, scaleY: 1 };

        expect(composeTransform(outer, inner)).toEqual({ x: 165, y: 225, scaleX: 1, scaleY: 1 });
        expect(composeTransform(IDENTITY_TRANSFORM, inner)).toEqual(inner);
    });

    it("applies the scale of the outer frame to the inner offset", () => {
        const outer = { x: 56, y: 126, scaleX: 0.5, scaleY: 0.5 };
        const inner = { x: 100, y: 100, scaleX: 1, scaleY: 1 };

        expect(composeTransform(outer, inner)).toEqual({
            x: 106, y: 176, scaleX: 0.5, scaleY: 0.5,
        });
    });

    it("maps points and rects with rounding", () => {
        const transform = { x: 56, y: 126, scaleX: 0.5, scaleY: 0.5 };

        expect(mapPoint(transform, { x: 61, y: 51 })).toEqual({ x: 87, y: 152 });
        expect(mapRect(transform, { x: 20, y: 30, width: 65, height: 35 })).toEqual({
            x: 66, y: 141, width: 33, height: 18,
        });
    });
});

describe("ownerGeometry", () => {
    it("takes the origin from the content box of an unscaled iframe", () => {
        const geometry = ownerGeometry(PLAIN_OWNER);

        expect(geometry.transform).toEqual({ x: 62, y: 132, scaleX: 1, scaleY: 1 });
        expect(geometry.borderOffset).toEqual({ x: 12, y: 12 });
    });

    it("derives the scale from the border box against its layout size", () => {
        expect(ownerGeometry(SCALED_OWNER).transform).toEqual({
            x: 56, y: 126, scaleX: 0.5, scaleY: 0.5,
        });
    });

    it("keeps the scale at one for an empty layout size", () => {
        const geometry = ownerGeometry({ ...PLAIN_OWNER, width: 0, height: 0 });

        expect(geometry.transform.scaleX).toBe(1);
        expect(geometry.transform.scaleY).toBe(1);
    });
});

describe("frameChain", () => {
    it("is empty for the main frame and for a frame of the same process", async () => {
        const fake = crossFake();
        const frames = framesOf(fake);

        expect((await frameChain(fake.asAccess(), frames, "tab1", "main")).links).toEqual([]);
        expect((await frameChain(fake.asAccess(), frames, "tab1", "same")).links).toEqual([]);
    });

    it("asks the tab session for the owner of a first level frame", async () => {
        const fake = crossFake();
        const chain = await frameChain(fake.asAccess(), framesOf(fake), "tab1", "mid");
        const owner = fake.sent.find((call) => call.method === "DOM.getFrameOwner");

        expect(chain.links).toHaveLength(1);
        expect(owner).toMatchObject({ params: { frameId: "mid" } });
        expect(owner?.frameId).toBeUndefined();
    });

    it("asks the parent frame session for the owner of a nested frame", async () => {
        const fake = crossFake();
        const chain = await frameChain(fake.asAccess(), framesOf(fake), "tab1", "deep");
        const owners = fake.sent.filter((call) => call.method === "DOM.getFrameOwner");

        expect(chain.links).toHaveLength(2);
        expect(owners.map((call) => [call.params?.frameId, call.frameId])).toEqual([
            ["deep", "mid"],
            ["mid", undefined],
        ]);
    });

    it("explains a frame whose owner element is gone", async () => {
        const fake = crossFake();

        fake.failSend = (_tab, method) =>
            method === "DOM.getFrameOwner" ? new RpcError(ErrorCode.cdpError, "No frame owner") : undefined;

        await expect(frameChain(fake.asAccess(), framesOf(fake), "tab1", "mid")).rejects.toThrow(
            ToolError,
        );
    });
});

describe("measureChain", () => {
    it("adds the iframe content origins of a nested chain", async () => {
        const fake = crossFake();
        const chain = await frameChain(fake.asAccess(), framesOf(fake), "tab1", "deep");
        const measured = await measureChain(chain, "tab1");

        expect(measured.toTop).toEqual({ x: 165, y: 225, scaleX: 1, scaleY: 1 });
        expect(measured.steps).toHaveLength(2);
    });

    it("is the identity for a frame of the main process", async () => {
        const fake = crossFake();
        const chain = await frameChain(fake.asAccess(), framesOf(fake), "tab1", "same");

        expect((await measureChain(chain, "tab1")).toTop).toEqual(IDENTITY_TRANSFORM);
    });

    it("explains an iframe without a box", async () => {
        const fake = crossFake();
        const chain = await frameChain(fake.asAccess(), framesOf(fake), "tab1", "mid");

        fake.failSend = (_tab, method) =>
            method === "DOM.getBoxModel" ? new RpcError(ErrorCode.cdpError, "Could not compute box model.") : undefined;

        await expect(measureChain(chain, "tab1")).rejects.toThrow(/no box on the page/);
    });
});

describe("revealChain", () => {
    it("scrolls each iframe owner into view with the rect relative to its border box", async () => {
        const fake = crossFake();
        const chain = await frameChain(fake.asAccess(), framesOf(fake), "tab1", "deep");

        fake.sent.length = 0;
        await revealChain(chain, "tab1", { x: 10, y: 20, width: 30, height: 40 });

        const scrolls = fake.sent.filter((call) => call.method === "DOM.scrollIntoViewIfNeeded");

        expect(scrolls.map((call) => [call.frameId, call.params])).toEqual([
            ["mid", { backendNodeId: 4, rect: { x: 13, y: 23, width: 30, height: 40 } }],
            [undefined, { backendNodeId: 6, rect: { x: 125, y: 125, width: 30, height: 40 } }],
        ]);
    });
});

describe("outerHitTest", () => {
    function hitFake(answer: unknown): FakeAccess {
        const fake = crossFake();
        const base = fake.respond;

        fake.respond = (tab, method, params) => {
            if (method === "DOM.resolveNode") return { object: { objectId: "owner" } };

            if (method === "Runtime.callFunctionOn") return { result: { type: "object", value: answer } };

            return base?.(tab, method, params);
        };

        return fake;
    }

    it("reports a hit when every iframe owner is the topmost element", async () => {
        const fake = hitFake({ kind: "hit" });
        const chain = await frameChain(fake.asAccess(), framesOf(fake), "tab1", "mid");
        const measured = await measureChain(chain, "tab1");

        expect(await outerHitTest(chain, measured, "tab1", { x: 50, y: 40 })).toEqual({ kind: "hit" });
    });

    it("reports the element that covers an iframe, probing in the parent viewport", async () => {
        const fake = hitFake({ kind: "covered", tag: "div", id: "banner", classes: ["a"] });
        const chain = await frameChain(fake.asAccess(), framesOf(fake), "tab1", "mid");
        const measured = await measureChain(chain, "tab1");
        const hit = await outerHitTest(chain, measured, "tab1", { x: 50, y: 40 });
        const probe = fake.sent.find((call) => call.method === "Runtime.callFunctionOn");

        expect(hit).toEqual({ kind: "covered", by: { tag: "div", id: "banner", classes: ["a"] } });
        expect(probe?.params?.arguments).toEqual([{ value: 112 }, { value: 172 }]);
    });

    it("reports a point outside the parent viewport", async () => {
        const fake = hitFake({ kind: "outside" });
        const chain = await frameChain(fake.asAccess(), framesOf(fake), "tab1", "mid");
        const measured = await measureChain(chain, "tab1");

        expect(await outerHitTest(chain, measured, "tab1", { x: 5000, y: 5000 })).toEqual({ kind: "outside" });
    });
});

describe("settleRendering", () => {
    it("waits for animation frames in every session and ignores a session that fails", async () => {
        const fake = new FakeAccess();

        fake.failSend = (_tab, method) =>
            method === "Runtime.evaluate" && fake.sent.length === 1
                ? new RpcError(ErrorCode.cdpError, "Cannot find context with specified id")
                : undefined;
        fake.respond = () => ({ result: { type: "boolean", value: true } });

        await settleRendering([fake.asAccess(), fake.asAccess()], "tab1");

        expect(fake.sent.map((call) => call.method)).toEqual(["Runtime.evaluate", "Runtime.evaluate"]);
        expect(fake.sent[0]?.params).toMatchObject({ awaitPromise: true, returnByValue: true });
        expect(String(fake.sent[0]?.params?.expression)).toContain("requestAnimationFrame");
    });
});
