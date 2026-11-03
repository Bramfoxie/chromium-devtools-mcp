import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { inputDrag, runTool, ToolRuntime } from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
import { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

interface World {
    intercept? : boolean;
    failMoveAt?: number;
    node?      : { frameId?: string; owner?: string };
}

function dragFake(world: World = {}): FakeAccess {
    const fake = new FakeAccess({
        tabs  : [{ targetId: "tab1", url: "https://a.example/", title: "t", owned: true, created: true }],
        frames: [
            { frameId: "main", url: "https://a.example/", name: "", isolated: false },
            {
                frameId      : "other",
                parentFrameId: "main",
                url          : "https://b.example/",
                name         : "pay",
                isolated     : true,
            },
        ],
    });
    let moves = 0;

    fake.respond = (_tab, method, params) => {
        switch (method) {
            case "Emulation.setFocusEmulationEnabled":
            case "Input.setInterceptDrags":
            case "Input.dispatchDragEvent":
                return {};

            case "Input.dispatchMouseEvent": {
                const type = (params as { type?: string }).type;

                if (type === "mouseMoved" && (params as { buttons?: number }).buttons === 1) {
                    moves += 1;

                    if (world.failMoveAt === moves) throw new Error("browser went away");
                }

                if (type === "mouseMoved" && world.intercept === true) {
                    fake.emit("cdp.event", {
                        targetId: "tab1",
                        event   : "Input.dragIntercepted",
                        params  : { data: { items: [], dragOperationsMask: 1 } },
                    });
                }

                return {};
            }

            case "Page.getLayoutMetrics":
                return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };

            case "DOM.getNodeForLocation":
                return { backendNodeId: 7, frameId: world.node?.frameId ?? "main" };

            case "DOM.describeNode": {
                const owner = world.node?.owner;

                return { node: owner === undefined ? {} : { frameId: owner } };
            }

            case "Runtime.evaluate":
                return { result: { type: "string", value: "https://a.example/" } };

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

const methods = (fake: FakeAccess) => fake.sent.map((call) => call.method);

const mouseTypes = (fake: FakeAccess) =>
    fake.sent
        .filter((call) => call.method === "Input.dispatchMouseEvent")
        .map((call) => (call.params as { type: string }).type);

const text = (result: { content: unknown }) => JSON.stringify(result.content);

describe("input_drag input schema", () => {
    const accepts = (value: unknown) => inputDrag.input.safeParse(value).success;

    it("takes an element or a point at each end", () => {
        expect(accepts({ from: { selector: "#a" }, to: { selector: "#b" } })).toBe(true);
        expect(accepts({ from: { uid: "1_1" }, to: { x: 1, y: 2 } })).toBe(true);
        expect(accepts({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, steps: 50 })).toBe(true);
        expect(accepts({ from: { x: 1, y: 2 } })).toBe(false);
        expect(accepts({ from: { x: 1, y: 2 }, to: { x: 3 } })).toBe(false);
        expect(accepts({ from: { x: 1, y: 2 }, to: { selector: "#a", x: 3, y: 4 } })).toBe(false);
        expect(accepts({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, steps: 0 })).toBe(false);
        expect(accepts({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, steps: 51 })).toBe(false);
    });
});

describe("input_drag between points", () => {
    it("presses, moves in steps and releases as a plain mouse drag when nothing is intercepted", async () => {
        const fake = dragFake();
        const result = await runTool(
            inputDrag,
            { from: { x: 10, y: 20 }, to: { x: 110, y: 220 }, steps: 4 },
            extra(),
            runtimeOf(fake),
        );

        expect(result.structuredContent).toMatchObject({
            ok  : true,
            kind: "pointer",
            from: { x: 10, y: 20 },
            to  : { x: 110, y: 220 },
        });
        expect(mouseTypes(fake)).toEqual([
            "mouseMoved",
            "mousePressed",
            "mouseMoved",
            "mouseMoved",
            "mouseMoved",
            "mouseMoved",
            "mouseReleased",
        ]);
        expect(methods(fake)).not.toContain("Input.dispatchDragEvent");

        const moves = fake.sent
            .filter((call) => call.method === "Input.dispatchMouseEvent")
            .map((call) => call.params as { type: string; buttons: number; x: number; y: number })
            .filter((params) => params.type === "mouseMoved" && params.buttons === 1)
            .map((params) => [params.x, params.y]);

        expect(moves).toEqual([[35, 70], [60, 120], [85, 170], [110, 220]]);
        expect(fake.sent.at(-1)?.method).not.toBe("Input.setInterceptDrags");
        expect(
            fake.sent
                .filter((call) => call.method === "Input.setInterceptDrags")
                .map((call) => (call.params as { enabled: boolean }).enabled),
        ).toEqual([true, false]);
    });

    it("completes a native drag with enter, over and drop at the target", async () => {
        const fake = dragFake({ intercept: true });
        const result = await runTool(
            inputDrag,
            { from: { x: 10, y: 20 }, to: { x: 110, y: 220 } },
            extra(),
            runtimeOf(fake),
        );
        const dragTypes = fake.sent
            .filter((call) => call.method === "Input.dispatchDragEvent")
            .map((call) => call.params as { type: string; x: number; y: number });

        expect(result.structuredContent).toMatchObject({ kind: "html5" });
        expect(dragTypes.map((event) => event.type)).toEqual(["dragEnter", "dragOver", "drop"]);
        expect(dragTypes.every((event) => event.x === 110 && event.y === 220)).toBe(true);
        expect(mouseTypes(fake).at(-1)).toBe("mouseReleased");
    });

    it("releases the button and stops intercepting when a move fails", async () => {
        const fake = dragFake({ failMoveAt: 2 });
        const result = await runTool(
            inputDrag,
            { from: { x: 10, y: 20 }, to: { x: 110, y: 220 }, steps: 4 },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).toBe(true);
        expect(mouseTypes(fake).at(-1)).toBe("mouseReleased");
        expect(
            fake.sent
                .filter((call) => call.method === "Input.setInterceptDrags")
                .map((call) => (call.params as { enabled: boolean }).enabled),
        ).toEqual([true, false]);
    });

    it("refuses a point outside the viewport before any mouse event", async () => {
        const fake = dragFake();
        const result = await runTool(
            inputDrag,
            { from: { x: 10, y: 20 }, to: { x: 5000, y: 20 } },
            extra(),
            runtimeOf(fake),
        );

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("outside the viewport");
        expect(mouseTypes(fake)).toEqual([]);
    });
});

describe("input_drag with allowedDomains", () => {
    const restricted: Config = {
        ...managedConfig,
        safety: { ...managedConfig.safety, allowedDomains: ["a.example"] },
    };

    it("refuses a drop point inside a frame from another origin before pressing", async () => {
        const fake = dragFake({ node: { frameId: "main", owner: "other" } });
        const result = await runTool(
            inputDrag,
            { from: { x: 10, y: 20 }, to: { x: 110, y: 220 } },
            extra(),
            runtimeOf(fake, restricted),
        );

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("b.example");
        expect(mouseTypes(fake)).toEqual([]);
    });

    it("refuses a target element in a frame outside the list at the gate", async () => {
        const fake = dragFake();
        const result = await runTool(
            inputDrag,
            { from: { x: 10, y: 20 }, to: { selector: "#b", frame: "other" } },
            extra(),
            runtimeOf(fake, restricted),
        );

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("b.example");
        expect(fake.sent).toEqual([]);
    });
});

describe("input_drag in read-only mode", () => {
    it("is refused", async () => {
        const fake = dragFake();
        const config: Config = {
            ...managedConfig,
            safety: { ...managedConfig.safety, readOnly: true },
        };
        const result = await runTool(
            inputDrag,
            { from: { x: 10, y: 20 }, to: { x: 30, y: 40 } },
            extra(),
            runtimeOf(fake, config),
        );

        expect(result.isError).toBe(true);
        expect(text(result)).toContain("read-only mode");
        expect(fake.sent).toEqual([]);
    });
});
