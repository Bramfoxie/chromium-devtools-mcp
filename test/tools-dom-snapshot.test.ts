import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
    domInfoMap,
    domSnapshot,
    newTab,
    runTool,
    SNAPSHOT_DOM_DEPTH,
    SNAPSHOT_MAX_AX_DEPTH,
    SNAPSHOT_MAX_AX_NODES,
    SNAPSHOT_MAX_CHARS,
    ToolRuntime,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

function setup(access?: FakeAccess) {
    const fake = access ?? new FakeAccess();
    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

    return { fake, runtime };
}

const TREE = {
    nodes: [
        {
            nodeId          : "1",
            role            : { value: "heading" },
            name            : { value: "Example Domain" },
            properties      : [{ name: "level", value: { value: 1 } }],
            childIds        : ["2"],
            backendDOMNodeId: 11,
        },
        {
            nodeId          : "2",
            role            : { value: "link" },
            name            : { value: "More information..." },
            backendDOMNodeId: 12,
        },
        { nodeId: "3", role: { value: "generic" }, childIds: [] },
    ],
};

const DOM = {
    root: {
        backendNodeId: 1,
        nodeName     : "HTML",
        children     : [
            {
                backendNodeId: 12,
                nodeName     : "A",
                attributes   : ["href", "https://www.iana.org/domains/example", "target", "_blank"],
            },
        ],
    },
};

function snapshotFake(tree: unknown = TREE, dom: unknown = DOM) {
    const fake = new FakeAccess();

    fake.respond = (_targetId, method) => {
        switch (method) {
            case "Accessibility.getFullAXTree":
                return tree;
            case "Accessibility.getPartialAXTree":
                return tree;
            case "DOM.getDocument":
                return dom;
            default:
                throw new Error(`unexpected CDP call ${method}`);
        }
    };

    return fake;
}

describe("domInfoMap", () => {
    it("indexes backend node ids with the kept attributes", () => {
        const map = domInfoMap(DOM);

        expect(map.get(12)).toEqual({
            tag  : "a",
            attrs: { href: "https://www.iana.org/domains/example" },
        });
        expect(map.get(1)).toEqual({ tag: "html", attrs: {} });
        expect(map.get(99)).toBeUndefined();
    });

    it("rejects a malformed document", () => {
        expect(() => domInfoMap({ root: { children: ["nope"] } })).toThrow(
            "unexpected response to DOM.getDocument",
        );
    });
});

describe("dom_snapshot", () => {
    it("renders the snapshot, assigns uids and bumps the generation", async () => {
        const fake = snapshotFake();
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        runtime.elements.nextGeneration("tab1");
        const [old] = runtime.elements.assign("tab1", [{ backendNodeId: 99 }]);
        const result = await runTool(domSnapshot, {}, extra(), runtime);

        expect(result.structuredContent).toEqual({
            snapshot:
                '[2_1] heading level 1 "Example Domain"\n  [2_2] link "More information..." href="https://www.iana.org/domains/example"',
            generation: 2,
            nodeCount : 2,
            omitted   : 1,
            truncated : false,
            frames    : [],
        });
        expect(fake.sent.map((call) => call.method)).toEqual([
            "Accessibility.getFullAXTree",
            "DOM.getDocument",
        ]);
        expect(fake.sent[1]?.params).toEqual({ depth: SNAPSHOT_DOM_DEPTH, pierce: true });
        expect(runtime.elements.lookup("tab1", "2_1")).toEqual({ backendNodeId: 11 });
        expect(runtime.elements.lookup("tab1", "2_2")).toEqual({ backendNodeId: 12 });
        expect(runtime.elements.lookup("tab1", old ?? "")).toBeUndefined();
    });

    it("truncates the text at maxChars with the marker", async () => {
        const fake = snapshotFake();
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(domSnapshot, { maxChars: 20 }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ truncated: true });
        expect(result.structuredContent).toMatchObject({
            snapshot: expect.stringContaining("[truncated:"),
        });
    });

    it("limits the snapshot to a root subtree", async () => {
        const fake = snapshotFake();
        const seen: unknown[] = [];

        fake.respond = (_targetId, method, params) => {
            if (method === "Accessibility.getPartialAXTree") seen.push(params);

            if (method === "DOM.getDocument") return DOM;
            if (method === "DOM.resolveNode") return { object: { objectId: "obj-7" } };

            return {
                nodes: [
                    { nodeId: "0", role: { value: "RootWebArea" }, childIds: ["1"] },
                    {
                        nodeId          : "1",
                        role            : { value: "heading" },
                        name            : { value: "Example Domain" },
                        childIds        : [],
                        backendDOMNodeId: 7,
                    },
                ],
            };
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        runtime.elements.nextGeneration("tab1");

        const [uid] = runtime.elements.assign("tab1", [{ backendNodeId: 7 }]);
        const result = await runTool(domSnapshot, { root: { uid } }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            snapshot: '[2_1] heading "Example Domain"',
        });
        expect(seen).toEqual([{ backendNodeId: 7, fetchRelatives: true }]);
        expect(fake.sent.map((call) => call.method)).toEqual([
            "DOM.resolveNode",
            "Runtime.releaseObject",
            "Accessibility.getPartialAXTree",
            "DOM.getDocument",
        ]);
    });

    it("reports a stale root uid without calling the browser", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(domSnapshot, { root: { uid: "3_3" } }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("stale");
        expect(fake.sent).toEqual([]);
    });

    it("names new_tab when no tab is selected", async () => {
        const { runtime } = setup();
        const result = await runTool(domSnapshot, {}, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("new_tab");
    });
});

describe("frame snapshot helpers", () => {
    const FRAMED = {
        root: {
            backendNodeId: 1,
            nodeName     : "HTML",
            children     : [
                {
                    backendNodeId  : 20,
                    nodeName       : "IFRAME",
                    frameId        : "frame1",
                    attributes     : ["title", "same-origin"],
                    contentDocument: {
                        backendNodeId: 21,
                        nodeName     : "#document",
                        children     : [
                            { backendNodeId: 22, nodeName: "BUTTON", attributes: ["id", "same-btn"] },
                        ],
                    },
                },
                {
                    backendNodeId: 30,
                    nodeName     : "DIV",
                    attributes   : ["id", "host"],
                    shadowRoots  : [
                        {
                            backendNodeId: 31,
                            nodeName     : "#document-fragment",
                            children     : [
                                { backendNodeId: 32, nodeName: "BUTTON", attributes: ["id", "open-btn"] },
                            ],
                        },
                    ],
                },
            ],
        },
    };

    it("maps iframe owners to frame ids and finds frame documents", async () => {
        const { iframeFrameMap, frameDocBackends } = await import("../src/tools/index.js");

        expect([...iframeFrameMap(FRAMED)]).toEqual([[20, "frame1"]]);
        expect(frameDocBackends(FRAMED)).toEqual([{ frameId: "frame1", backendNodeId: 21 }]);
    });

    it("collects dom info through shadow roots and frame documents", async () => {
        const { domInfoMap } = await import("../src/tools/index.js");
        const map = domInfoMap(FRAMED);

        expect(map.get(22)).toEqual({ tag: "button", attrs: { id: "same-btn" } });
        expect(map.get(32)).toEqual({ tag: "button", attrs: { id: "open-btn" } });
    });

    it("renders a frame section under its boundary marker", async () => {
        const fake = new FakeAccess({
            frames: [
                { frameId: "main", url: "https://a.example/", name: "", isolated: false },
                {
                    frameId      : "frame1",
                    parentFrameId: "main",
                    url          : "https://b.example/",
                    name         : "pay",
                    isolated     : true,
                },
            ],
        });

        fake.respond = (_targetId, method, params) => {
            switch (method) {
                case "Accessibility.getFullAXTree": {
                    const frame = (params as { frameId?: unknown })?.frameId;

                    if (frame === "frame1") {
                        return {
                            nodes: [
                                {
                                    nodeId          : "2",
                                    role            : { value: "button" },
                                    name            : { value: "Pay" },
                                    childIds        : [],
                                    backendDOMNodeId: 22,
                                },
                            ],
                        };
                    }

                    return {
                        nodes: [
                            {
                                nodeId          : "1",
                                role            : { value: "Iframe" },
                                name            : { value: "same-origin" },
                                childIds        : [],
                                backendDOMNodeId: 20,
                            },
                        ],
                    };
                }

                case "DOM.getDocument":
                    return FRAMED;
                default:
                    throw new Error(`unexpected CDP call ${method}`);
            }
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(domSnapshot, {}, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            snapshot : expect.stringContaining('iframe "same-origin" frame=frame1'),
            nodeCount: 2,
            frames   : [
                {
                    frameId  : "main",
                    url      : "https://a.example/",
                    isolated : false,
                    nodeCount: 0,
                    omitted  : false,
                },
                {
                    frameId  : "frame1",
                    parent   : "main",
                    url      : "https://b.example/",
                    isolated : true,
                    nodeCount: 1,
                    omitted  : false,
                },
            ],
        });
        expect(result.structuredContent).toMatchObject({
            snapshot: expect.stringContaining('button "Pay"'),
        });
        expect(
            fake.sent.find((call) => call.method === "Accessibility.getFullAXTree" &&
                (call.params as { frameId?: string } | undefined)?.frameId === "frame1")?.params,
        ).toEqual({ depth: SNAPSHOT_MAX_AX_DEPTH, frameId: "frame1" });
        expect(fake.sent.some((call) => call.method === "Accessibility.getPartialAXTree")).toBe(false);
        expect(runtime.elements.lookup("tab1", "1_2")).toEqual({
            backendNodeId  : 22,
            frameId        : "frame1",
            frameGeneration: 0,
        });
    });

    it("marks the snapshot when the DOM is deeper than the depth limit", async () => {
        const deep = {
            root: {
                backendNodeId: 1,
                nodeName     : "HTML",
                children     : [
                    { backendNodeId: 12, nodeName: "DIV", childNodeCount: 3 },
                ],
            },
        };
        const fake = snapshotFake(TREE, deep);
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(domSnapshot, {}, extra(), runtime);

        expect(result.structuredContent).toMatchObject({
            snapshot : expect.stringContaining("[truncated: the DOM is deeper than 10 levels"),
            truncated: true,
        });
    });

    it("does not mark a complete DOM as depth limited", async () => {
        const { runtime } = setup(snapshotFake());

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(domSnapshot, {}, extra(), runtime);

        expect(JSON.stringify(result.structuredContent)).not.toContain("deeper than");
        expect(result.structuredContent).toMatchObject({ truncated: false });
    });

    it("asks the browser for a bounded accessibility depth", async () => {
        const fake = snapshotFake();
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;
        await runTool(domSnapshot, {}, extra(), runtime);

        expect(fake.sent.find((call) => call.method === "Accessibility.getFullAXTree")?.params).toEqual({
            depth: SNAPSHOT_MAX_AX_DEPTH,
        });
    });

    it("marks a tree whose nodes were cut at the depth limit", async () => {
        const cut = {
            nodes: [
                {
                    nodeId          : "1",
                    role            : { value: "heading" },
                    name            : { value: "Top" },
                    childIds        : ["2"],
                    backendDOMNodeId: 11,
                },
            ],
        };
        const { runtime } = setup(snapshotFake(cut));

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(domSnapshot, {}, extra(), runtime);

        expect(result.structuredContent).toMatchObject({
            snapshot : expect.stringContaining("[truncated: the accessibility tree has more than"),
            truncated: true,
        });
    });

    it("keeps only the first nodes beyond the node cap and marks the result", async () => {
        const nodes = Array.from({ length: SNAPSHOT_MAX_AX_NODES + 5 }, (_, index) => ({
            nodeId          : String(index + 1),
            role            : { value: "link" },
            name            : { value: `n${index}` },
            backendDOMNodeId: 1000 + index,
        }));
        const { runtime } = setup(snapshotFake({ nodes }));

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(
            domSnapshot,
            { maxChars: SNAPSHOT_MAX_CHARS },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({
            nodeCount: SNAPSHOT_MAX_AX_NODES,
            truncated: true,
        });
    });

    it("applies interactiveOnly to frame sections", async () => {
        const fake = new FakeAccess({
            frames: [
                { frameId: "main", url: "https://a.example/", name: "", isolated: false },
                {
                    frameId      : "frame1",
                    parentFrameId: "main",
                    url          : "https://b.example/",
                    name         : "pay",
                    isolated     : true,
                },
            ],
        });

        fake.respond = (_targetId, method, params) => {
            switch (method) {
                case "Accessibility.getFullAXTree":
                    if ((params as { frameId?: unknown })?.frameId === "frame1") {
                        return {
                            nodes: [
                                {
                                    nodeId          : "2",
                                    role            : { value: "heading" },
                                    name            : { value: "Title text" },
                                    childIds        : ["3"],
                                    backendDOMNodeId: 23,
                                },
                                {
                                    nodeId          : "3",
                                    role            : { value: "button" },
                                    name            : { value: "Pay" },
                                    childIds        : [],
                                    backendDOMNodeId: 22,
                                },
                            ],
                        };
                    }

                    return {
                        nodes: [
                            {
                                nodeId          : "1",
                                role            : { value: "Iframe" },
                                name            : { value: "same-origin" },
                                childIds        : [],
                                backendDOMNodeId: 20,
                            },
                        ],
                    };
                case "DOM.getDocument":
                    return FRAMED;
                default:
                    throw new Error(`unexpected CDP call ${method}`);
            }
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        const result = await runTool(domSnapshot, { interactiveOnly: true }, extra(), runtime);
        const text = (result.structuredContent as { snapshot: string }).snapshot;

        expect(text).toContain('button "Pay"');
        expect(text).not.toContain("Title text");
    });

    const OVER_CAP = SNAPSHOT_MAX_AX_NODES + 5;

    it("caps the accessibility tree of a same-origin frame and marks the truncation", async () => {
        const fake = new FakeAccess({
            frames: [
                { frameId: "main", url: "https://a.example/", name: "", isolated: false },
                {
                    frameId      : "frame1",
                    parentFrameId: "main",
                    url          : "https://a.example/inner",
                    name         : "",
                    isolated     : false,
                },
            ],
        });

        fake.respond = (_targetId, method, params) => {
            switch (method) {
                case "Accessibility.getFullAXTree":
                    if ((params as { frameId?: unknown })?.frameId === "frame1") {
                        return {
                            nodes: Array.from({ length: OVER_CAP }, (_, index) => ({
                                nodeId          : String(index + 1),
                                role            : { value: "link" },
                                name            : { value: `n${index}` },
                                childIds        : [],
                                backendDOMNodeId: 5000 + index,
                            })),
                        };
                    }

                    return { nodes: [] };
                case "DOM.getDocument":
                    return FRAMED;
                default:
                    throw new Error(`unexpected CDP call ${method}`);
            }
        };

        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);

        const args = { maxChars: SNAPSHOT_MAX_CHARS };
        const result = await runTool(domSnapshot, args, extra(), runtime);

        expect(result.structuredContent).toMatchObject({
            nodeCount: SNAPSHOT_MAX_AX_NODES,
            truncated: true,
            snapshot : expect.stringContaining("[truncated: the accessibility tree has more than"),
        });
    });
});
