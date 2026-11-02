import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
    cssInspect,
    domSnapshot,
    ElementRegistry,
    jsEvaluate,
    runTool,
    screenshot,
    SNAPSHOT_MAX_AX_NODES,
    ToolRuntime,
} from "../src/tools/index.js";
import { CHILD_BOX, crossSiteFake, MID_FRAME } from "./helpers/cross-site-fake.js";
import { managedConfig } from "./helpers/daemon-env.js";
import type { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

type Overlay = (
    tab    : string,
    method : string,
    params : Record<string, unknown> | undefined,
    session: string | undefined,
) => unknown;

function setup(overlay: Overlay): { fake: FakeAccess; runtime: ToolRuntime } {
    const fake = crossSiteFake();
    const base = fake.respond;

    fake.respond = (tab, method, params) =>
        overlay(tab, method, params, fake.sent.at(-1)?.frameId) ?? base?.(tab, method, params);
    const runtime = new ToolRuntime({
        access  : fake.asAccess(),
        config  : managedConfig,
        elements: new ElementRegistry(),
    });

    runtime.tabs.refresh(
        [{ targetId: "tab1", url: "http://a.example/", title: "t", owned: true, created: true }],
        "tab1",
    );
    runtime.elements.nextGeneration("tab1");
    runtime.elements.assign("tab1", [{ backendNodeId: 101, frameId: MID_FRAME, isolated: true }]);

    return { fake, runtime };
}

describe("js_evaluate with a target in a cross-site frame", () => {
    it("calls the function and releases the objects on the frame session", async () => {
        const { fake, runtime } = setup((_tab, method, params) => {
            const text = String((params as { functionDeclaration?: unknown } | undefined)
                ?.functionDeclaration);

            if (method === "Runtime.callFunctionOn" && text.includes("return this.id")) {
                return { result: { type: "string", value: "b" } };
            }

            if (method === "Runtime.releaseObject") return {};

            return undefined;
        });
        const result = await runTool(
            jsEvaluate,
            { target: { uid: "1_1" }, expression: "return this.id" },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({ ok: true, type: "string", value: "b" });
        const sessions = fake.sent
            .filter((call) => call.method === "Runtime.callFunctionOn" ||
                call.method === "Runtime.releaseObject")
            .map((call) => call.frameId);

        expect(sessions.length).toBeGreaterThan(0);
        expect(sessions.every((session) => session === MID_FRAME)).toBe(true);
    });

    it("stops a runaway script in the frame session when the deadline passes", async () => {
        const { fake, runtime } = setup(() => undefined);
        const base = fake.respond;

        fake.respond = (tab, method, params) =>
            method === "Runtime.callFunctionOn"
                ? new Promise(() => undefined)
                : base?.(tab, method, params);

        const result = await runTool(
            jsEvaluate,
            { target: { uid: "1_1" }, expression: "while(true){}", timeoutMs: 50 },
            extra(),
            runtime,
        );
        const stop = fake.sent.find((call) => call.method === "Runtime.terminateExecution");

        expect(result.isError).toBe(true);
        expect(stop?.frameId).toBe(MID_FRAME);
    });
});

describe("css_inspect in a cross-site frame", () => {
    const styles = (_tab: string, method: string): unknown => {
        switch (method) {
            case "DOM.describeNode":
                return { node: { nodeId: 55, backendNodeId: 101 } };
            case "DOM.enable":
            case "CSS.enable":
            case "CSS.disable":
            case "Runtime.releaseObject":
                return {};
            case "CSS.getComputedStyleForNode":
                return { computedStyle: [{ name: "color", value: "rgb(255, 0, 0)" }] };
            case "CSS.getMatchedStylesForNode":
                return { matchedCSSRules: [], inherited: [] };
            default:
                return undefined;
        }
    };

    it("reads the styles from the frame session", async () => {
        const { fake, runtime } = setup(styles);
        const result = await runTool(
            cssInspect,
            { target: { uid: "1_1" }, properties: ["color"] },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            computed: { color: "rgb(255, 0, 0)" },
        });
        const nodeCalls = fake.sent.filter(
            (call) => call.method.startsWith("CSS.") ||
                (call.method === "DOM.describeNode" && call.params?.backendNodeId === 101),
        );

        expect(nodeCalls.length).toBeGreaterThan(0);
        expect(nodeCalls.every((call) => call.frameId === MID_FRAME)).toBe(true);
    });

    it("reports the box in page coordinates through the iframe offset", async () => {
        const { runtime } = setup(styles);
        const result = await runTool(
            cssInspect,
            { target: { uid: "1_1" }, properties: ["color"] },
            extra(),
            runtime,
        );
        const box = (result.structuredContent as { box: Record<string, unknown> }).box;

        expect(CHILD_BOX.content[0]).toBe(28);
        expect(box.content).toEqual({ x: 90, y: 165, width: 64, height: 34 });
        expect(box.border).toEqual({ x: 82, y: 162, width: 80, height: 40 });
    });
});

describe("screenshot with a target in a cross-site frame", () => {
    const PNG = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00,
    ]);

    it("clips the page capture to the box translated through the iframe", async () => {
        const { fake, runtime } = setup((_tab, method) => {
            if (method === "Page.getLayoutMetrics") {
                const viewport = { pageX: 0, pageY: 300, clientWidth: 785, clientHeight: 600 };

                return { cssLayoutViewport: viewport, layoutViewport: viewport };
            }

            if (method === "Page.captureScreenshot") return { data: PNG.toString("base64") };

            return undefined;
        });
        const result = await runTool(
            screenshot,
            { target: { uid: "1_1" }, format: "png" },
            extra(),
            runtime,
        );
        const shot = fake.sent.find((call) => call.method === "Page.captureScreenshot");

        expect(result.isError).not.toBe(true);
        expect(shot?.frameId).toBeUndefined();
        expect(shot?.params?.clip).toMatchObject({ x: 90, y: 465, width: 64, height: 34 });
    });
});

describe("dom_snapshot with cross-site frames", () => {
    const main = {
        root: {
            backendNodeId: 1,
            nodeName     : "HTML",
            children     : [{
                backendNodeId: 5,
                nodeName     : "IFRAME",
                frameId      : MID_FRAME,
                attributes   : ["name", "cross"],
            }],
        },
    };
    const child = {
        root: {
            backendNodeId: 100,
            nodeName     : "#document",
            children     : [{
                backendNodeId: 101,
                nodeName     : "BUTTON",
                attributes   : ["id", "b"],
            }],
        },
    };
    const mainTree = {
        nodes: [{
            nodeId          : "1",
            role            : { value: "Iframe" },
            name            : { value: "cross" },
            childIds        : [],
            backendDOMNodeId: 5,
        }],
    };
    const childTree = {
        nodes: [
            { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"], backendDOMNodeId: 100 },
            {
                nodeId          : "2",
                role            : { value: "button" },
                name            : { value: "go" },
                childIds        : [],
                backendDOMNodeId: 101,
            },
        ],
    };

    function snapshotOverlay(options: { childNodes?: unknown } = {}): Overlay {
        return (_tab, method, _params, session) => {
            const inChild = session === MID_FRAME;

            switch (method) {
                case "Accessibility.getFullAXTree":
                    return inChild ? (options.childNodes ?? childTree) : mainTree;
                case "Accessibility.getPartialAXTree":
                    return inChild ? childTree : mainTree;
                case "DOM.getDocument":
                    return inChild ? child : main;
                case "Runtime.releaseObject":
                    return {};
                default:
                    return undefined;
            }
        };
    }

    it("renders the document of a cross-site frame from its own session", async () => {
        const { fake, runtime } = setup(snapshotOverlay());
        const result = await runTool(domSnapshot, {}, extra(), runtime);
        const data = result.structuredContent as {
            snapshot : string;
            nodeCount: number;
            frames   : Array<{ frameId: string; isolated: boolean; nodeCount: number }>;
        };

        expect(result.isError).not.toBe(true);
        expect(data.snapshot).toContain('iframe "cross" frame=mid');
        expect(data.snapshot).toContain('button "go"');
        expect(data.frames.find((frame) => frame.frameId === MID_FRAME)).toMatchObject({
            isolated : true,
            nodeCount: 1,
        });
        expect(data.nodeCount).toBe(2);
        const childCalls = fake.sent.filter((call) => call.frameId === MID_FRAME)
            .map((call) => call.method);

        const tree = fake.sent.find((call) => call.method === "Accessibility.getFullAXTree" &&
            call.frameId === MID_FRAME);

        expect(tree?.params).toEqual({ depth: 50, frameId: MID_FRAME });
        expect(childCalls).toContain("Accessibility.getFullAXTree");
        expect(childCalls).toContain("DOM.getDocument");
    });

    it("gives elements of the frame uids that resolve through the frame session", async () => {
        const { runtime } = setup(snapshotOverlay());

        await runTool(domSnapshot, {}, extra(), runtime);

        const found = [1, 2, 3].map((n) => runtime.elements.lookup("tab1", `2_${n}`));

        expect(found).toContainEqual({
            backendNodeId  : 101,
            frameId        : MID_FRAME,
            isolated       : true,
            frameGeneration: 0,
        });
    });

    it("caps the accessibility tree of a frame and marks the truncation", async () => {
        const many = {
            nodes: Array.from({ length: SNAPSHOT_MAX_AX_NODES + 5 }, (_, index) => ({
                nodeId          : String(index + 1),
                role            : { value: "generic" },
                childIds        : [],
                backendDOMNodeId: 1000 + index,
            })),
        };
        const { runtime } = setup(snapshotOverlay({ childNodes: many }));
        const result = await runTool(domSnapshot, {}, extra(), runtime);
        const data = result.structuredContent as { snapshot: string; truncated: boolean };

        expect(data.truncated).toBe(true);
        expect(data.snapshot).toContain("[truncated: the accessibility tree has more than");
    });

    it("leaves a frame out of the sections when maxFrames is reached", async () => {
        const { fake, runtime } = setup(snapshotOverlay());
        const result = await runTool(domSnapshot, { maxFrames: 0 }, extra(), runtime);
        const data = result.structuredContent as {
            frames: Array<{ frameId: string; omitted: boolean; nodeCount: number }>;
        };

        expect(data.frames.find((frame) => frame.frameId === MID_FRAME)).toMatchObject({
            omitted  : true,
            nodeCount: 0,
        });
        expect(fake.sent.some((call) => call.frameId === MID_FRAME)).toBe(false);
    });

    it("limits the snapshot to the subtree of an element in the frame", async () => {
        const { fake, runtime } = setup(snapshotOverlay());
        const result = await runTool(domSnapshot, { root: { uid: "1_1" } }, extra(), runtime);
        const data = result.structuredContent as { snapshot: string };

        expect(result.isError).not.toBe(true);
        expect(data.snapshot).toContain('button "go"');
        const partial = fake.sent.find((call) => call.method === "Accessibility.getPartialAXTree");

        expect(partial).toMatchObject({ frameId: MID_FRAME, params: { backendNodeId: 101 } });
        expect(runtime.elements.lookup("tab1", "2_1")).toMatchObject({
            frameId : MID_FRAME,
            isolated: true,
        });
    });
});
