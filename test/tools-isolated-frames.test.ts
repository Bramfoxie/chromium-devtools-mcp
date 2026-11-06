import { describe, expect, it } from "vitest";
import { ElementRegistry, FrameState, resolveElement } from "../src/tools/index.js";
import { bindAccess, isolatedDocumentNode } from "../src/tools/frame-scope.js";
import { withWheelProbe } from "../src/tools/wheel-probe.js";
import { FakeAccess } from "./helpers/fake-access.js";

function crossFake(): FakeAccess {
    const fake = new FakeAccess();

    fake.frames = [
        { frameId: "main", url: "https://a.example/", name: "", isolated: false },
        { frameId: "cross", parentFrameId: "main", url: "https://b.example/", name: "pay", isolated: true },
        { frameId: "inside", parentFrameId: "cross", url: "https://b.example/in", name: "in", isolated: true },
    ];

    fake.respond = (_targetId, method, params) => {
        const frameId = fake.sent.at(-1)?.frameId;

        switch (method) {
            case "Page.getFrameTree":
                return { frameTree: { frame: { id: frameId === "cross" ? "cross" : "main" } } };
            case "DOM.getDocument":
                if (frameId === undefined) {
                    return {
                        root: {
                            nodeId  : 1,
                            nodeName: "#document",
                            children: [{ nodeId: 10, nodeName: "IFRAME", frameId: "cross" }],
                        },
                    };
                }

                return {
                    root: {
                        nodeId  : 100,
                        nodeName: "#document",
                        children: [
                            {
                                nodeId         : 110,
                                nodeName       : "IFRAME",
                                frameId        : "inside",
                                contentDocument: { nodeId: 111, nodeName: "#document" },
                            },
                        ],
                    },
                };
            case "DOM.querySelector":
                return (params as { selector?: unknown })?.selector === "#frame" ? { nodeId: 10 } : { nodeId: 141 };
            case "DOM.querySelectorAll":
                return { nodeIds: [10] };
            case "DOM.describeNode":
                return (params as { nodeId?: unknown })?.nodeId === 10
                    ? { node: { nodeName: "IFRAME", frameId: "cross", backendNodeId: 20 } }
                    : { node: { nodeId: 141, backendNodeId: 7 } };
            case "DOM.resolveNode":
                return { object: { objectId: "obj-cross" } };
            default:
                throw new Error(`unexpected CDP call ${method}`);
        }
    };

    return fake;
}

describe("bindAccess", () => {
    it("sends commands to the bound frame unless another one is given", async () => {
        const fake = crossFake();
        const bound = bindAccess(fake.asAccess(), "cross");

        await bound.send({
            targetId: "tab1",
            method  : "Page.getFrameTree",
            params  : {},
        });
        await bound.send({
            targetId: "tab1",
            method  : "Page.getFrameTree",
            params  : {},
            frameId : "other",
        });

        expect(fake.sent.map((call) => call.frameId)).toEqual(["cross", "other"]);
    });
});

describe("isolatedDocumentNode", () => {
    it("returns the document of the session root frame", async () => {
        const fake = crossFake();
        const bound = bindAccess(fake.asAccess(), "cross");

        expect(await isolatedDocumentNode(bound, "tab1", "cross")).toBe(100);
    });

    it("returns the content document of a frame inside the session", async () => {
        const fake = crossFake();
        const bound = bindAccess(fake.asAccess(), "cross");

        expect(await isolatedDocumentNode(bound, "tab1", "inside")).toBe(111);
    });
});

describe("elements in a cross site frame", () => {
    async function resolve(frame: string) {
        const fake = crossFake();
        const frames = new FrameState({ access: fake.asAccess() });

        await frames.ensure("tab1");

        const resolved = await resolveElement(
            fake.asAccess(),
            new ElementRegistry(),
            "tab1",
            { selector: "#pay-btn", frame },
            { frames },
        );

        return { fake, resolved };
    }

    it("resolves an element through the session that owns the frame", async () => {
        const { fake, resolved } = await resolve("cross");

        expect(resolved).toEqual({
            backendNodeId: 7,
            objectId     : "obj-cross",
            frameId      : "cross",
            isolated     : true,
        });
        const owned = fake.sent.filter((call) => call.frameId === "cross").map((call) => call.method);

        expect(owned).toContain("DOM.querySelector");
        expect(owned).toContain("DOM.resolveNode");
        expect(fake.sent.find((call) => call.method === "DOM.querySelector")?.params)
            .toEqual({ nodeId: 100, selector: "#pay-btn" });
    });

    it("resolves the frame named by an iframe selector the main document cannot open", async () => {
        const { resolved } = await resolve("#frame");

        expect(resolved).toMatchObject({ frameId: "cross", isolated: true });
    });
});

describe("wheel probe routing", () => {
    it("routes nested frame hit tests and probe calls to their owners", async () => {
        const fake = crossFake();
        const frames = new FrameState({ access: fake.asAccess() });

        fake.respond = (_tab, method) => {
            const frame = fake.sent.at(-1)?.frameId;

            if (method === "DOM.getNodeForLocation") return { frameId: frame ?? "main", backendNodeId: 1 };
            if (method === "DOM.describeNode") return { node: frame === undefined ? { frameId: "cross" } : frame === "cross" ? { frameId: "inside" } : {} };
            if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 100, 0, 100, 100, 0, 100], border: [0, 0, 100, 0, 100, 100, 0, 100], width: 100, height: 100 } };
            if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
            if (method === "Runtime.evaluate") return { result: { value: true } };

            throw new Error(`unexpected CDP call ${method}`);
        };

        expect(await withWheelProbe(fake.asAccess(), frames, "tab1", { x: 50, y: 50 }, (read) => read())).toBe(true);
        expect(fake.sent.filter((entry) => entry.method === "DOM.getNodeForLocation").map((entry) => entry.frameId)).toEqual([undefined, "cross", "inside"]);
        expect(fake.sent.filter((entry) => entry.method === "Runtime.evaluate" || entry.method === "Page.createIsolatedWorld").map((entry) => entry.frameId)).toEqual(["inside", "inside", "inside", "inside"]);
    });
});
