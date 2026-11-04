import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { inputClick, runTool, ToolRuntime } from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

const FRAMES = [
    { frameId: "main", url: "https://a.example/", name: "", isolated: false },
    { frameId: "same", parentFrameId: "main", url: "https://a.example/in", name: "", isolated: false },
    { frameId: "other", parentFrameId: "main", url: "https://b.example/", name: "pay", isolated: true },
    { frameId: "blank", parentFrameId: "main", url: "about:blank", name: "", isolated: false },
];

interface World {
    viewport?: { clientWidth: number; clientHeight: number };
    under?   : { tag: string; id: string; classes: string[] } | null;
    node?    : { frameId?: string; owner?: string } | "none" | "error";
}

function pointFake(world: World = {}): FakeAccess {
    const fake = new FakeAccess({
        tabs  : [{ targetId: "tab1", url: "https://a.example/", title: "t", owned: true, created: true }],
        frames: FRAMES,
    });

    fake.respond = (_tab, method, params) => {
        switch (method) {
            case "Emulation.setFocusEmulationEnabled":
            case "Input.dispatchMouseEvent":
                return {};

            case "Page.getLayoutMetrics":
                return {
                    cssLayoutViewport: world.viewport ?? { clientWidth: 800, clientHeight: 600 },
                };

            case "DOM.getNodeForLocation": {
                if (world.node === "none") throw new Error("No node found at given location");
                if (world.node === "error") throw new Error("connection lost");

                return { backendNodeId: 7, frameId: (world.node ?? {}).frameId ?? "main" };
            }

            case "DOM.describeNode": {
                const owner = world.node === undefined || typeof world.node === "string"
                    ? undefined
                    : world.node.owner;

                return { node: owner === undefined ? {} : { frameId: owner } };
            }

            case "Runtime.evaluate": {
                const expression = String((params as { expression?: unknown }).expression);

                if (expression === "location.href") {
                    return { result: { type: "string", value: "https://a.example/" } };
                }

                if (expression.includes("elementFromPoint")) {
                    return {
                        result: {
                            type : "object",
                            value: world.under === undefined
                                ? { tag: "button", id: "buy", classes: ["primary"] }
                                : world.under,
                        },
                    };
                }

                throw new Error(`unexpected evaluate ${expression}`);
            }

            default:
                throw new Error(`unexpected call ${method}`);
        }
    };

    return fake;
}

function runtimeOf(fake: FakeAccess, config: Config = managedConfig): ToolRuntime {
    const runtime = new ToolRuntime({ access: fake.asAccess(), config });

    runtime.tabs.select("tab1");

    return runtime;
}

const restricted: Config = {
    ...managedConfig,
    safety: { ...managedConfig.safety, allowedDomains: ["a.example"] },
};

const mouse = (fake: FakeAccess) =>
    fake.sent
        .filter((call) => call.method === "Input.dispatchMouseEvent")
        .map((call) => call.params as Record<string, unknown>);

const text = (result: { content: unknown }) => JSON.stringify(result.content);

describe("input_click at a point", () => {
    it("moves, presses and releases at the point and describes the element under it", async () => {
        const fake = pointFake();
        const runtime = runtimeOf(fake);
        const result = await runTool(inputClick, { point: { x: 120, y: 45 } }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({
            ok    : true,
            target: { tag: "button", id: "buy", classes: ["primary"] },
            effect: "The point (120, 45) was left clicked.",
        });
        expect(mouse(fake).map((event) => [event.type, event.x, event.y])).toEqual([
            ["mouseMoved", 120, 45],
            ["mousePressed", 120, 45],
            ["mouseReleased", 120, 45],
        ]);
        expect(fake.sent.some((call) => call.method.startsWith("DOM."))).toBe(false);
    });

    it("honours button, click count and modifiers", async () => {
        const fake = pointFake();
        const result = await runTool(
            inputClick,
            { point: { x: 5, y: 6 }, button: "right", clickCount: 2, modifiers: ["Control"] },
            extra(),
            runtimeOf(fake),
        );
        const presses = mouse(fake).filter((event) => event.type === "mousePressed");

        expect(result.structuredContent).toMatchObject({
            effect: "The point (5, 6) was right clicked 2 times.",
        });
        expect(presses.map((event) => event.clickCount)).toEqual([1, 2]);
        expect(presses.every((event) => event.button === "right" && event.modifiers === 2)).toBe(true);
    });

    it("omits the target when nothing is under the point", async () => {
        const result = await runTool(
            inputClick,
            { point: { x: 1, y: 1 } },
            extra(),
            runtimeOf(pointFake({ under: null })),
        );

        expect(result.structuredContent).toEqual({
            ok    : true,
            effect: "The point (1, 1) was left clicked.",
        });
    });

    it("refuses a point outside the viewport before sending any mouse event", async () => {
        const fake = pointFake({ viewport: { clientWidth: 300, clientHeight: 200 } });
        const runtime = runtimeOf(fake);
        const result = await runTool(inputClick, { point: { x: 300, y: 10 } }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("outside the viewport of 300 by 200");
        expect(mouse(fake)).toEqual([]);
    });

    describe("input schema", () => {
        const accepts = (value: unknown) => inputClick.input.safeParse(value).success;

        it("takes exactly one of target and point", () => {
            expect(accepts({ point: { x: 1, y: 2 } })).toBe(true);
            expect(accepts({ target: { selector: "a" } })).toBe(true);
            expect(accepts({})).toBe(false);
            expect(accepts({ target: { selector: "a" }, point: { x: 1, y: 2 } })).toBe(false);
        });

        it("keeps position and force for elements and rejects bad points", () => {
            expect(accepts({ point: { x: 1, y: 2 }, position: { x: 1, y: 1 } })).toBe(false);
            expect(accepts({ point: { x: 1, y: 2 }, force: true })).toBe(false);
            expect(accepts({ point: { x: -1, y: 2 } })).toBe(false);
            expect(accepts({ point: { x: Number.NaN, y: 2 } })).toBe(false);
            expect(accepts({ point: { x: 1 } })).toBe(false);
        });
    });
});

describe("input_click at a point with allowedDomains", () => {
    it("clicks a point in the main frame and in a frame from an allowed origin", async () => {
        for (const frameId of ["main", "same"]) {
            const fake = pointFake({ node: { frameId } });
            const result = await runTool(
                inputClick,
                { point: { x: 10, y: 10 } },
                extra(),
                runtimeOf(fake, restricted),
            );

            expect(result.isError).not.toBe(true);
            expect(mouse(fake)).toHaveLength(3);
        }
    });

    it("clicks a point in an inherited about:blank frame", async () => {
        const fake = pointFake({ node: { frameId: "blank" } });
        const result = await runTool(
            inputClick,
            { point: { x: 10, y: 10 } },
            extra(),
            runtimeOf(fake, restricted),
        );

        expect(result.isError).not.toBe(true);
    });

    it("refuses a point inside a frame owner whose frame comes from another origin", async () => {
        const fake = pointFake({ node: { frameId: "main", owner: "other" } });
        const result = await runTool(
            inputClick,
            { point: { x: 10, y: 10 } },
            extra(),
            runtimeOf(fake, restricted),
        );

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("b.example");
        expect(text(result)).toContain("safety.allowedDomains");
        expect(mouse(fake)).toEqual([]);
    });

    it("refuses a point in a frame that is not known", async () => {
        const fake = pointFake({ node: { frameId: "mystery" } });
        const result = await runTool(
            inputClick,
            { point: { x: 10, y: 10 } },
            extra(),
            runtimeOf(fake, restricted),
        );

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("could not be checked");
        expect(mouse(fake)).toEqual([]);
    });

    it("refuses when the frame lookup fails but allows an empty spot", async () => {
        const failing = pointFake({ node: "error" });
        const refused = await runTool(
            inputClick,
            { point: { x: 10, y: 10 } },
            extra(),
            runtimeOf(failing, restricted),
        );

        expect(refused.isError).toBe(true);
        expect(mouse(failing)).toEqual([]);

        const empty = pointFake({ node: "none" });
        const allowed = await runTool(
            inputClick,
            { point: { x: 10, y: 10 } },
            extra(),
            runtimeOf(empty, restricted),
        );

        expect(allowed.isError).not.toBe(true);
    });

    it("does not look for frames when there is no allowlist", async () => {
        const fake = pointFake({ node: { frameId: "other" } });

        await runTool(inputClick, { point: { x: 10, y: 10 } }, extra(), runtimeOf(fake));

        expect(fake.sent.some((call) => call.method === "DOM.getNodeForLocation")).toBe(false);
    });
});
