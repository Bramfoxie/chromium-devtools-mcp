import { describe, expect, it } from "vitest";
import { ElementRegistry, FrameState, resolveElement, ToolError } from "../src/tools/index.js";
import { bindAccess, isolatedDocumentNode } from "../src/tools/frame-scope.js";
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

        await bound.send("tab1", "Page.getFrameTree", {});
        await bound.send("tab1", "Page.getFrameTree", {}, undefined, "other");

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
    async function resolve(frame: string, allowIsolated: boolean) {
        const fake = crossFake();
        const frames = new FrameState({ access: fake.asAccess() });

        await frames.ensure("tab1");

        const resolved = await resolveElement(
            fake.asAccess(),
            new ElementRegistry(),
            "tab1",
            { selector: "#pay-btn", frame },
            { frames, allowIsolated },
        );

        return { fake, resolved };
    }

    it("resolves an element through the session that owns the frame", async () => {
        const { fake, resolved } = await resolve("cross", true);

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
        const { resolved } = await resolve("#frame", true);

        expect(resolved).toMatchObject({ frameId: "cross", isolated: true });
    });

    it("refuses an element in such a frame for tools that cannot act on it", async () => {
        const failure = await resolve("cross", false).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ToolError);
        expect((failure as Error).message).toContain("cross-site frame");
    });
});
