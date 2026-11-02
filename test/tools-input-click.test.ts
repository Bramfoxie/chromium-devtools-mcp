import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import {
    click,
    ElementRegistry,
    inputClick,
    inputHover,
    newTab,
    runTool,
    ToolRuntime,
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

interface MouseWorld {
    state?      : Record<string, unknown>;
    hit?        : Record<string, unknown>;
    urlAfter?   : string;
    hovered?    : boolean;
    clickThrows?: boolean;
    left?       : number;
}

function mouseFake(world: MouseWorld = {}): FakeAccess {
    const fake = new FakeAccess();

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

            case "DOM.getBoxModel": {
                const left = world.left ?? 10;
                const quad = [left, 20, left + 100, 20, left + 100, 70, left, 70];

                return { model: { content: quad, padding: quad, border: quad, margin: quad } };
            }

            case "Emulation.setFocusEmulationEnabled":
                return {};
            case "Input.dispatchMouseEvent":
                return {};

            case "Runtime.evaluate": {
                const expression = (params as { expression?: unknown })?.expression;

                if (expression === "location.href") {
                    return { result: { type: "string", value: "https://before.example/" } };
                }

                throw new Error(`unexpected evaluate ${String(expression)}`);
            }

            case "Runtime.callFunctionOn": {
                const declaration = (params as { functionDeclaration?: unknown })
                    ?.functionDeclaration;

                if (typeof declaration === "string" && declaration.includes("elementFromPoint")) {
                    return {
                        result: { type: "object", value: { kind: "hit", ...world.hit } },
                    };
                }

                if (typeof declaration === "string" && declaration.includes(":hover")) {
                    return { result: { type: "boolean", value: world.hovered ?? true } };
                }

                if (typeof declaration === "string" && declaration.includes("scrollIntoView")) {
                    if (world.clickThrows === true) {
                        return {
                            result          : { type: "undefined" },
                            exceptionDetails: { text: "handler exploded" },
                        };
                    }

                    return { result: { type: "string", value: "clicked" } };
                }

                return {
                    result: {
                        type : "object",
                        value: {
                            tag       : "button",
                            id        : "save",
                            classes   : ["primary"],
                            disabled  : false,
                            connected : true,
                            editable  : "none",
                            selectable: false,
                            fileInput : false,
                            ...world.state,
                        },
                    },
                };
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

    return { fake, runtime };
}

function selected(runtime: ToolRuntime): void {
    runtime.tabs.refresh(
        [{ targetId: "tab1", url: "https://before.example/", title: "t", owned: true, created: true }],
        "tab1",
    );
}

function contentOf(result: { content: unknown }): string {
    return JSON.stringify(result.content);
}

function navigatedFake(world: MouseWorld = {}): FakeAccess {
    const fake = mouseFake(world);
    let calls = 0;
    const respond = fake.respond;

    fake.respond = (targetId, method, params) => {
        if (method === "Runtime.evaluate") {
            calls += 1;

            return {
                result: {
                    type : "string",
                    value: calls === 1 ? "https://before.example/" : (world.urlAfter ?? "https://after.example/"),
                },
            };
        }

        return respond?.(targetId, method, params);
    };

    return fake;
}

describe("click", () => {
    it("clicks a resolved element by uid and reports no navigation", async () => {
        const { fake, runtime } = runtimeWith(mouseFake());

        selected(runtime);
        runtime.elements.nextGeneration("tab1");
        runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);
        const result = await runTool(click, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            ok    : true,
            target: { uid: "1_1", tag: "button", id: "save", classes: ["primary"] },
            effect: "The element was clicked.",
        });
        expect(result.structuredContent).not.toHaveProperty("urlAfter");
        expect(fake.sent.map((entry) => entry.method)).toContain("Runtime.callFunctionOn");
        expect(
            fake.sent.filter((entry) => entry.method === "Input.dispatchMouseEvent"),
        ).toHaveLength(0);
    });

    it("reports the URL only when the click navigated", async () => {
        const { runtime } = runtimeWith(navigatedFake());

        selected(runtime);
        runtime.elements.nextGeneration("tab1");
        runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);
        const result = await runTool(click, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({
            ok      : true,
            urlAfter: "https://after.example/",
        });
    });

    it("reports a throwing handler as ok false instead of a tool error", async () => {
        const { runtime } = runtimeWith(mouseFake({ clickThrows: true }));

        selected(runtime);
        runtime.elements.nextGeneration("tab1");
        runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);
        const result = await runTool(click, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ ok: false });
    });

    it("points file inputs at input_upload without clicking", async () => {
        const { fake, runtime } = runtimeWith(mouseFake({ state: { fileInput: true } }));

        selected(runtime);
        runtime.elements.nextGeneration("tab1");
        runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);
        const result = await runTool(click, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(contentOf(result)).toContain("input_upload");
        expect(
            fake.sent.filter((entry) =>
                entry.method === "Runtime.callFunctionOn" &&
                String((entry.params as { functionDeclaration?: unknown })?.functionDeclaration)
                    .includes("scrollIntoView"),
            ),
        ).toHaveLength(0);
    });

    it("refuses a disabled element and asks for a tab when none is selected", async () => {
        const { runtime } = runtimeWith(mouseFake({ state: { disabled: true } }));

        selected(runtime);
        runtime.elements.nextGeneration("tab1");
        runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);
        const disabled = await runTool(click, { target: { uid: "1_1" } }, extra(), runtime);

        expect(disabled.isError).toBe(true);
        expect(contentOf(disabled)).toContain("disabled");

        const { runtime: empty } = runtimeWith(mouseFake());
        const noTab = await runTool(click, { target: { uid: "1_1" } }, extra(), empty);

        expect(noTab.isError).toBe(true);
        expect(contentOf(noTab)).toContain("new_tab");
    });

    it("resolves a selector and passes scrollIntoView through", async () => {
        const { fake, runtime } = runtimeWith(mouseFake());

        selected(runtime);
        await runTool(
            click,
            { target: { selector: "#save" }, scrollIntoView: false },
            extra(),
            runtime,
        );
        const call = fake.sent.find((entry) => {
            const declaration = (entry.params as { functionDeclaration?: unknown })
                ?.functionDeclaration;

            return entry.method === "Runtime.callFunctionOn" &&
                String(declaration).includes("scrollIntoView");
        });

        expect(call?.params).toMatchObject({
            arguments: [{ objectId: "obj-11" }, { value: false }],
        });
    });
});

describe("input_click", () => {
    it("sends move, press and release at the element center once per tab session", async () => {
        const { fake, runtime } = runtimeWith(mouseFake());

        selected(runtime);
        runtime.elements.nextGeneration("tab1");
        runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);
        const result = await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);
        const again = await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(again.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            ok    : true,
            target: { tag: "button" },
            effect: "The element was left clicked.",
        });
        const mouse = fake.sent.filter((entry) => entry.method === "Input.dispatchMouseEvent");

        expect(mouse.map((entry) => entry.params?.type)).toEqual([
            "mouseMoved",
            "mousePressed",
            "mouseReleased",
            "mouseMoved",
            "mousePressed",
            "mouseReleased",
        ]);
        expect(mouse[0]?.params).toMatchObject({ x: 60, y: 45, buttons: 0, clickCount: 0 });
        expect(mouse[1]?.params).toMatchObject({
            x         : 60,
            y         : 45,
            button    : "left",
            buttons   : 1,
            clickCount: 1,
            modifiers : 0,
        });
        expect(
            fake.sent.filter((entry) => entry.method === "Emulation.setFocusEmulationEnabled"),
        ).toHaveLength(1);
    });

    it("honours button, click count, modifiers and position", async () => {
        const { fake, runtime } = runtimeWith(mouseFake());

        selected(runtime);
        runtime.elements.nextGeneration("tab1");
        runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);
        const result = await runTool(
            inputClick,
            {
                target    : { uid: "1_1" },
                button    : "right",
                clickCount: 2,
                modifiers : ["Control"],
                position  : { x: 0, y: 0 },
            },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            effect: "The element was right clicked 2 times.",
        });
        const mouse = fake.sent.filter((entry) => entry.method === "Input.dispatchMouseEvent");

        expect(mouse.map((entry) => [entry.params?.type, entry.params?.clickCount])).toEqual([
            ["mouseMoved", 0],
            ["mousePressed", 1],
            ["mouseReleased", 1],
            ["mousePressed", 2],
            ["mouseReleased", 2],
        ]);
        expect(mouse[3]?.params).toMatchObject({
            x        : 10,
            y        : 20,
            button   : "right",
            buttons  : 2,
            modifiers: 2,
        });
    });

    it("dedupes modifiers and rejects an unknown modifier", async () => {
        const { fake, runtime } = runtimeWith(mouseFake());

        selected(runtime);
        runtime.elements.nextGeneration("tab1");
        runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);
        const result = await runTool(
            inputClick,
            { target: { uid: "1_1" }, modifiers: ["Shift", "Shift"] },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(
            fake.sent.find((entry) => entry.method === "Input.dispatchMouseEvent")?.params,
        ).toMatchObject({ modifiers: 8 });

        const bad = await runTool(
            inputClick,
            { target: { uid: "1_1" }, modifiers: ["Hyper"] },
            extra(),
            runtime,
        );

        expect(bad.isError).toBe(true);
        expect(contentOf(bad)).toContain("Invalid arguments");
    });

    it("reports a covered element and clicks through it only with force", async () => {
        const { fake, runtime } = runtimeWith(
            mouseFake({ hit: { kind: "covered", tag: "div", id: "overlay", classes: ["modal"] } }),
        );

        selected(runtime);
        runtime.elements.nextGeneration("tab1");
        runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);
        const covered = await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);

        expect(covered.isError).toBe(true);
        expect(contentOf(covered)).toContain("div#overlay.modal");
        expect(
            fake.sent.filter((entry) => entry.method === "Input.dispatchMouseEvent"),
        ).toHaveLength(0);

        const forced = await runTool(
            inputClick,
            { target: { uid: "1_1" }, force: true },
            extra(),
            runtime,
        );

        expect(forced.isError).not.toBe(true);
        expect(
            fake.sent.filter((entry) => entry.method === "Input.dispatchMouseEvent"),
        ).toHaveLength(3);
    });

    it("reports navigation and refuses a stale uid or a dead tab", async () => {
        const { runtime } = runtimeWith(navigatedFake());

        selected(runtime);
        runtime.elements.nextGeneration("tab1");
        runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);
        const moved = await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);

        expect(moved.structuredContent).toMatchObject({ urlAfter: "https://after.example/" });

        const stale = await runTool(inputClick, { target: { uid: "9_9" } }, extra(), runtime);

        expect(stale.isError).toBe(true);
        expect(contentOf(stale)).toContain("stale");

        const failing = mouseFake();

        failing.failSend = () => new RpcError(ErrorCode.browserClosed, "The tab is gone.");
        const { runtime: dead } = runtimeWith(failing);

        selected(dead);
        dead.elements.nextGeneration("tab1");
        dead.elements.assign("tab1", [{ backendNodeId: 101 }]);
        const gone = await runTool(inputClick, { target: { uid: "1_1" } }, extra(), dead);

        expect(gone.isError).toBe(true);
        expect(contentOf(gone)).toContain("new_tab");
    });
});

describe("input_hover", () => {
    it("moves in two steps and checks :hover", async () => {
        const { fake, runtime } = runtimeWith(mouseFake({ hovered: true }));

        selected(runtime);
        runtime.elements.nextGeneration("tab1");
        runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);
        const result = await runTool(inputHover, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ ok: true, hovered: true });
        const mouse = fake.sent.filter((entry) => entry.method === "Input.dispatchMouseEvent");

        expect(mouse).toHaveLength(2);
        expect(mouse[0]?.params).toMatchObject({ type: "mouseMoved", x: 59, y: 45 });
        expect(mouse[1]?.params).toMatchObject({ type: "mouseMoved", x: 60, y: 45 });
    });

    it("leads in from inside the viewport when the point is at x 0", async () => {
        const { fake, runtime } = runtimeWith(mouseFake({ left: 0 }));

        selected(runtime);
        runtime.elements.nextGeneration("tab1");
        runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);
        const result = await runTool(
            inputHover,
            { target: { uid: "1_1" }, position: { x: 0, y: 5 } },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        const mouse = fake.sent.filter((entry) => entry.method === "Input.dispatchMouseEvent");

        expect(mouse.map((entry) => entry.params?.x)).toEqual([1, 0]);
    });

    it("reports a miss when :hover is not set and hovers through with force", async () => {
        const { fake, runtime } = runtimeWith(
            mouseFake({
                hit    : { kind: "covered", tag: "div", id: "menu", classes: [] },
                hovered: false,
            }),
        );

        selected(runtime);
        runtime.elements.nextGeneration("tab1");
        runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);
        const covered = await runTool(inputHover, { target: { uid: "1_1" } }, extra(), runtime);

        expect(covered.isError).toBe(true);
        expect(contentOf(covered)).toContain("hover through it");

        const forced = await runTool(
            inputHover,
            { target: { uid: "1_1" }, force: true },
            extra(),
            runtime,
        );

        expect(forced.isError).not.toBe(true);
        expect(forced.structuredContent).toMatchObject({ ok: false, hovered: false });
        expect(
            fake.sent.filter((entry) => entry.method === "Input.dispatchMouseEvent"),
        ).toHaveLength(2);
    });
});

describe("mouse tools", () => {
    it("never sends a focus stealing call", async () => {
        const { fake, runtime } = runtimeWith(mouseFake());

        selected(runtime);
        runtime.elements.nextGeneration("tab1");
        runtime.elements.assign("tab1", [{ backendNodeId: 101 }]);
        await runTool(newTab, {}, extra(), runtime);
        await runTool(click, { target: { uid: "1_1" } }, extra(), runtime);
        await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);
        await runTool(inputHover, { target: { uid: "1_1" } }, extra(), runtime);

        expect(fake.sent.map((entry) => entry.method)).not.toContain("Page.bringToFront");
        expect(fake.sent.map((entry) => entry.method)).not.toContain("Target.activateTarget");
    });
});

describe("input tools in shadow roots and frames", () => {
    function piercedMouseFake(): FakeAccess {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method, params) => {
            switch (method) {
                case "DOM.getDocument":
                    return { root: { nodeId: 1 } };

                case "DOM.querySelector": {
                    const selector = (params as { selector?: unknown })?.selector;

                    if (selector === "my-app") return { nodeId: 13 };

                    return { nodeId: 15 };
                }

                case "DOM.resolveNode":
                    return { object: { objectId: "obj-15" } };

                case "DOM.describeNode": {
                    const nodeId = (params as { nodeId?: unknown })?.nodeId;

                    if (nodeId === 13) {
                        return {
                            node: {
                                nodeName     : "MY-APP",
                                backendNodeId: 5,
                                shadowRoots  : [{ nodeId: 14 }],
                            },
                        };
                    }

                    return { node: { nodeId: 15, backendNodeId: 9 } };
                }

                case "DOM.scrollIntoViewIfNeeded":
                case "Emulation.setFocusEmulationEnabled":
                case "Input.dispatchMouseEvent":
                    return {};
                case "DOM.getBoxModel":
                    return BOX_MODEL;
                case "Runtime.evaluate":
                    return { result: { type: "string", value: "https://same.example/" } };

                case "Runtime.callFunctionOn": {
                    const declaration = (params as { functionDeclaration?: unknown })
                        ?.functionDeclaration;

                    if (
                        typeof declaration === "string" && declaration.includes("elementFromPoint")
                    ) {
                        return { result: { type: "object", value: { kind: "hit" } } };
                    }

                    if (typeof declaration === "string" && declaration.includes(":hover")) {
                        return { result: { type: "boolean", value: true } };
                    }

                    return {
                        result: {
                            type : "object",
                            value: {
                                tag       : "button",
                                id        : "open-btn",
                                classes   : [],
                                disabled  : false,
                                connected : true,
                                editable  : "none",
                                selectable: false,
                                fileInput : false,
                            },
                        },
                    };
                }

                default:
                    throw new Error(`unexpected CDP call ${method}`);
            }
        };

        return fake;
    }

    function piercedSetup() {
        const fake = piercedMouseFake();
        const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

        return { fake, runtime };
    }

    it("clicks a shadow element resolved through a chain", async () => {
        const { fake, runtime } = piercedSetup();

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(
            click,
            { target: { selector: "my-app >>> #open-btn" } },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ ok: true, effect: "The element was clicked." });
        expect(fake.sent.map((call) => call.method)).toContain("DOM.querySelector");
    });

    it("input_clicks a shadow element with a trusted mouse sequence", async () => {
        const { fake, runtime } = piercedSetup();

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(
            inputClick,
            { target: { selector: "my-app >>> #open-btn" } },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(fake.sent.filter((call) => call.method === "Input.dispatchMouseEvent")).toHaveLength(3);
    });

    it("hovers a shadow element", async () => {
        const { fake, runtime } = piercedSetup();

        await runTool(newTab, {}, extra(), runtime);
        fake.sent.length = 0;

        const result = await runTool(
            inputHover,
            { target: { selector: "my-app >>> #open-btn" } },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ ok: true, hovered: true });
    });
});
