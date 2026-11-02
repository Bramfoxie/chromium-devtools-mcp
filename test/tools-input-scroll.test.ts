import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
    ElementRegistry,
    inputScroll,
    runTool,
    scrollMoved,
    ToolRuntime,
    wheelParams,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const BOX_MODEL = {
    model: {
        content: [10, 20, 110, 20, 110, 70, 10, 70],
        padding: [10, 20, 110, 20, 110, 70, 10, 70],
        border : [10, 20, 110, 20, 110, 70, 10, 70],
        margin : [10, 20, 110, 20, 110, 70, 10, 70],
    },
};

interface ScrollPosition {
    x     : number;
    y     : number;
    maxX  : number;
    maxY  : number;
    width : number;
    height: number;
}

interface ScrollWorld {
    positions?: ScrollPosition[];
}

function scrollFake(world: ScrollWorld = {}): FakeAccess {
    const fake = new FakeAccess();
    const positions = world.positions ?? [
        { x: 0, y: 0, maxX: 0, maxY: 1000, width: 800, height: 600 },
        { x: 0, y: 300, maxX: 0, maxY: 1000, width: 800, height: 600 },
    ];
    let reads = 0;

    fake.respond = (_targetId, method, params) => {
        switch (method) {
            case "DOM.getDocument":
                return { root: { nodeId: 1 } };
            case "DOM.querySelector":
                return { nodeId: 11 };
            case "DOM.resolveNode":
                return { object: { objectId: "obj-11" } };
            case "DOM.describeNode":
                return { node: { backendNodeId: 101 } };
            case "DOM.scrollIntoViewIfNeeded":
                return {};
            case "DOM.getBoxModel":
                return BOX_MODEL;
            case "Emulation.setFocusEmulationEnabled":
                return {};
            case "Input.dispatchMouseEvent":
                return {};
            case "Runtime.callFunctionOn":
                if (
                    String((params as { functionDeclaration?: unknown })?.functionDeclaration)
                        .includes("scrollIntoView")
                ) {
                    return { result: { type: "undefined" } };
                }

                return {
                    result: {
                        type : "object",
                        value: {
                            tag       : "section",
                            id        : "",
                            classes   : [],
                            disabled  : false,
                            connected : true,
                            editable  : "none",
                            selectable: false,
                            fileInput : false,
                        },
                    },
                };

            case "Runtime.evaluate": {
                const expression = String((params as { expression?: unknown })?.expression ?? "");

                if (expression.includes("scrollBy")) {
                    return { result: { type: "string", value: "scrolled" } };
                }

                const position = positions[Math.min(reads, positions.length - 1)] ?? positions[0];

                reads += 1;

                return { result: { type: "object", value: position } };
            }

            default:
                throw new Error(`unexpected CDP call ${method}`);
        }
    };

    return fake;
}

function runtimeWith(fake: FakeAccess): { fake: FakeAccess; runtime: ToolRuntime } {
    const runtime = new ToolRuntime({
        access  : fake.asAccess(),
        config  : managedConfig,
        elements: new ElementRegistry(),
    });

    runtime.tabs.refresh(
        [{ targetId: "tab1", url: "https://page.example/", title: "t", owned: true, created: true }],
        "tab1",
    );
    runtime.elements.nextGeneration("tab1");
    runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);

    return { fake, runtime };
}

function contentOf(result: { content: unknown }): string {
    return JSON.stringify(result.content);
}

describe("wheelParams", () => {
    it("builds a trusted wheel event at the point", () => {
        expect(wheelParams({ x: 400, y: 300 }, 0, 250)).toEqual({
            type      : "mouseWheel",
            x         : 400,
            y         : 300,
            modifiers : 0,
            button    : "none",
            buttons   : 0,
            clickCount: 0,
            deltaX    : 0,
            deltaY    : 250,
        });
    });
});

describe("scrollMoved", () => {
    it("detects any movement on either axis", () => {
        const before = { x: 0, y: 100, maxX: 0, maxY: 1000, width: 800, height: 600 };

        expect(scrollMoved(before, { ...before })).toBe(false);
        expect(scrollMoved(before, { ...before, y: 200 })).toBe(true);
        expect(scrollMoved(before, { ...before, x: 10 })).toBe(true);
    });
});

describe("input_scroll", () => {
    it("scrolls by delta with a wheel event at the viewport center", async () => {
        const { fake, runtime } = runtimeWith(scrollFake());

        const result = await runTool(inputScroll, { deltaY: 300 }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            ok    : true,
            method: "wheel",
            x     : 0,
            y     : 300,
            maxX  : 0,
            maxY  : 1000,
        });
        const wheel = fake.sent.find((entry) => entry.method === "Input.dispatchMouseEvent");

        expect(wheel?.params).toMatchObject({
            type  : "mouseWheel",
            x     : 400,
            y     : 300,
            deltaX: 0,
            deltaY: 300,
        });
    });

    it("honours an explicit wheel point", async () => {
        const { fake, runtime } = runtimeWith(scrollFake());

        await runTool(inputScroll, { deltaY: 100, at: { x: 10, y: 500 } }, extra(), runtime);
        const wheel = fake.sent.find((entry) => entry.method === "Input.dispatchMouseEvent");

        expect(wheel?.params).toMatchObject({ x: 10, y: 500, deltaY: 100 });
    });

    it("refuses a wheel point outside the viewport before scrolling", async () => {
        const { fake, runtime } = runtimeWith(scrollFake());

        const result = await runTool(
            inputScroll,
            { deltaY: 100, at: { x: 900, y: 10 } },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(contentOf(result)).toContain("outside the viewport");
        expect(fake.sent.some((entry) => entry.method === "Input.dispatchMouseEvent")).toBe(false);
    });

    it("reports the window position when the wheel moves nothing", async () => {
        const still = { x: 0, y: 0, maxX: 0, maxY: 1000, width: 800, height: 600 };
        const { fake, runtime } = runtimeWith(scrollFake({ positions: [still] }));

        const result = await runTool(inputScroll, { deltaY: 300 }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ method: "wheel", y: 0 });
        expect(JSON.stringify(result.structuredContent)).toContain("window did not move");
        expect(
            fake.sent.filter((entry) =>
                entry.method === "Runtime.evaluate" &&
                String((entry.params as { expression?: unknown })?.expression).includes("scrollBy"),
            ),
        ).toHaveLength(0);
    });

    it("scrolls to the top and the bottom through the wheel", async () => {
        const { fake, runtime } = runtimeWith(scrollFake({
            positions: [
                { x: 0, y: 500, maxX: 0, maxY: 1000, width: 800, height: 600 },
                { x: 0, y: 0, maxX: 0, maxY: 1000, width: 800, height: 600 },
            ],
        }));

        const top = await runTool(inputScroll, { to: "top" }, extra(), runtime);

        expect(top.isError).not.toBe(true);
        expect(top.structuredContent).toMatchObject({ method: "wheel", y: 0 });
        const wheel = fake.sent.find((entry) => entry.method === "Input.dispatchMouseEvent");

        expect(wheel?.params).toMatchObject({ type: "mouseWheel", deltaY: -500 });
    });

    it("keeps wheeling until the bottom of a long page", async () => {
        const fake = scrollFake();
        const base = fake.respond ?? (() => ({}));
        let y = 0;

        fake.respond = (targetId, method, params) => {
            if (method === "Input.dispatchMouseEvent") {
                const delta = (params as { deltaY: number }).deltaY;

                y = Math.max(0, Math.min(99616, y + Math.min(20000, delta)));

                return {};
            }

            const expression = String((params as { expression?: unknown })?.expression ?? "");

            if (method === "Runtime.evaluate" && expression.includes("scrollWidth")) {
                return {
                    result: {
                        type : "object",
                        value: { x: 0, y, maxX: 0, maxY: 99616, width: 800, height: 600 },
                    },
                };
            }

            return base(targetId, method, params);
        };

        const { fake: used, runtime } = runtimeWith(fake);

        const result = await runTool(inputScroll, { to: "bottom" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ ok: true, y: 99616, maxY: 99616 });
        expect(
            used.sent.filter((entry) => entry.method === "Input.dispatchMouseEvent").length,
        ).toBeGreaterThan(4);
    });

    it("reports the real position when the page stops short of the edge", async () => {
        const stuck = { x: 0, y: 20000, maxX: 0, maxY: 99616, width: 800, height: 600 };
        const { runtime } = runtimeWith(scrollFake({ positions: [stuck] }));

        const result = await runTool(inputScroll, { to: "bottom" }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ ok: false, y: 20000, maxY: 99616 });
    });

    it("scrolls an element into view with the requested block", async () => {
        const { fake, runtime } = runtimeWith(scrollFake());

        const result = await runTool(
            inputScroll,
            { target: { uid: "1_1" }, block: "start" },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            method: "intoView",
            target: { uid: "1_1", tag: "section" },
        });
        const call = fake.sent.find((entry) => {
            const declaration = (entry.params as { functionDeclaration?: unknown })
                ?.functionDeclaration;

            return entry.method === "Runtime.callFunctionOn" &&
                String(declaration).includes("scrollIntoView({");
        });

        expect(call?.params).toMatchObject({
            arguments: [{ objectId: "obj-11" }, { value: "start" }],
        });
    });

    it("requires exactly one scroll mode", async () => {
        const { runtime } = runtimeWith(scrollFake());

        const none = await runTool(inputScroll, {}, extra(), runtime);

        expect(none.isError).toBe(true);
        expect(contentOf(none)).toContain("exactly one of target");

        const both = await runTool(
            inputScroll,
            { target: { uid: "1_1" }, deltaY: 10 },
            extra(),
            runtime,
        );

        expect(both.isError).toBe(true);
        expect(contentOf(both)).toContain("exactly one of target");

        const strayBlock = await runTool(inputScroll, { deltaY: 10, block: "start" }, extra(), runtime);

        expect(strayBlock.isError).toBe(true);
        expect(contentOf(strayBlock)).toContain("block needs a target");
    });

    it("never sends a focus stealing call", async () => {
        const { fake, runtime } = runtimeWith(scrollFake());

        await runTool(inputScroll, { deltaY: 10 }, extra(), runtime);
        await runTool(inputScroll, { target: { uid: "1_1" } }, extra(), runtime);
        expect(fake.sent.map((entry) => entry.method)).not.toContain("Page.bringToFront");
        expect(fake.sent.map((entry) => entry.method)).not.toContain("Target.activateTarget");
    });
});

describe("input_scroll in frames", () => {
    it("scrolls an element inside a frame into view", async () => {
        const fake = scrollFake();
        const inner = fake.respond?.bind(fake);

        fake.respond = (_targetId, method, params) => {
            if (method === "DOM.querySelectorAll") return { nodeIds: [10] };

            if (method === "DOM.querySelector") {
                const selector = (params as { selector?: unknown })?.selector;

                if (selector === "#frame") return { nodeId: 10 };

                return { nodeId: 41 };
            }

            if (method === "DOM.describeNode") {
                const nodeId = (params as { nodeId?: unknown })?.nodeId;

                if (nodeId === 10) {
                    return {
                        node: {
                            nodeName       : "IFRAME",
                            backendNodeId  : 20,
                            frameId        : "frame1",
                            contentDocument: { nodeId: 11 },
                        },
                    };
                }
            }

            return inner?.(_targetId, method, params) as unknown;
        };

        const { runtime } = runtimeWith(fake);
        const result = await runTool(
            inputScroll,
            { target: { selector: "#inner", frame: "#frame" } },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ ok: true, method: "intoView" });
    });
});
