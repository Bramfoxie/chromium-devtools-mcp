import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
    ElementRegistry,
    inputClick,
    inputHover,
    runTool,
    ToolRuntime,
} from "../src/tools/index.js";
import { crossSiteFake, MID_FRAME, type CrossSiteWorld } from "./helpers/cross-site-fake.js";
import { managedConfig } from "./helpers/daemon-env.js";
import type { FakeAccess } from "./helpers/fake-access.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

function setup(world: CrossSiteWorld = {}): { fake: FakeAccess; runtime: ToolRuntime } {
    const fake = crossSiteFake(world);
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

function mouseEvents(fake: FakeAccess): Array<{ type: unknown; x: unknown; y: unknown }> {
    return fake.sent
        .filter((call) => call.method === "Input.dispatchMouseEvent")
        .map((call) => ({ type: call.params?.type, x: call.params?.x, y: call.params?.y }));
}

describe("input_click in a cross-site frame", () => {
    it("dispatches the mouse events through the tab at top-level coordinates", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(mouseEvents(fake)).toEqual([
            { type: "mouseMoved", x: 122, y: 182 },
            { type: "mousePressed", x: 122, y: 182 },
            { type: "mouseReleased", x: 122, y: 182 },
        ]);
        expect(
            fake.sent.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.frameId),
        ).toEqual([undefined, undefined, undefined]);
    });

    it("measures the element and runs the hit test in the frame session", async () => {
        const { fake, runtime } = setup();

        await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);

        const inFrame = fake.sent
            .filter((call) => call.frameId === MID_FRAME)
            .map((call) => call.method);

        expect(inFrame).toContain("DOM.scrollIntoViewIfNeeded");
        expect(inFrame).toContain("Runtime.callFunctionOn");
        const hit = fake.sent.find(
            (call) => call.frameId === MID_FRAME && Array.isArray(call.params?.arguments) &&
                call.params.arguments.length === 4,
        );

        expect(hit?.params?.arguments).toEqual([
            { objectId: "obj-mid" },
            { value: 60 },
            { value: 50 },
            { value: true },
        ]);
    });

    it("waits for a rendered frame in the tab and frame sessions before measuring", async () => {
        const { fake, runtime } = setup();

        await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);

        const settles = fake.sent.filter(
            (call) => call.method === "Runtime.evaluate" &&
                String(call.params?.expression).includes("requestAnimationFrame"),
        );
        const measures = fake.sent.map(
            (call) => call.method === "DOM.getBoxModel" && call.params?.backendNodeId === 6,
        );
        const lastMeasure = measures.lastIndexOf(true);
        const firstSettle = fake.sent.findIndex((call) => call.method === "Runtime.evaluate" &&
            String(call.params?.expression).includes("requestAnimationFrame"));

        expect(settles.map((call) => call.frameId)).toContain(MID_FRAME);
        expect(settles.map((call) => call.frameId)).toContain(undefined);
        expect(settles.every((call) => call.params?.awaitPromise === true)).toBe(true);
        expect(firstSettle).toBeGreaterThan(-1);
        expect(lastMeasure).toBeGreaterThan(firstSettle);
    });

    it("scrolls the iframe element into view in the parent session", async () => {
        const { fake, runtime } = setup();

        await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);

        const scroll = fake.sent.find(
            (call) => call.method === "DOM.scrollIntoViewIfNeeded" && call.frameId === undefined,
        );

        expect(scroll?.params).toMatchObject({ backendNodeId: 6 });
    });

    it("honors an offset position inside the element", async () => {
        const { fake, runtime } = setup();

        await runTool(
            inputClick,
            { target: { uid: "1_1" }, position: { x: 10, y: 4 } },
            extra(),
            runtime,
        );

        expect(mouseEvents(fake)[0]).toEqual({ type: "mouseMoved", x: 100, y: 169 });
    });

    it("refuses to click through an element covering it inside the frame", async () => {
        const { fake, runtime } = setup({ innerHit: { kind: "covered", tag: "div", id: "veil", classes: [] } });
        const result = await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("div#veil");
        expect(mouseEvents(fake)).toEqual([]);
    });

    it("refuses to click through an element of the parent page covering the iframe", async () => {
        const { fake, runtime } = setup({ outerHit: { kind: "covered", tag: "div", id: "banner", classes: [] } });
        const result = await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("div#banner");
        expect(mouseEvents(fake)).toEqual([]);
    });

    it("clicks through a cover when forced, still at translated coordinates", async () => {
        const { fake, runtime } = setup({ outerHit: { kind: "covered", tag: "div", id: "banner", classes: [] } });
        const result = await runTool(
            inputClick,
            { target: { uid: "1_1" }, force: true },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(mouseEvents(fake)[1]).toEqual({ type: "mousePressed", x: 122, y: 182 });
    });

    it("reports a point outside the frame viewport", async () => {
        const { runtime } = setup({ innerHit: { kind: "outside" } });
        const result = await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("outside the frame viewport");
    });
});

describe("input_hover in a cross-site frame", () => {
    it("moves the mouse to the translated point and reads :hover in the frame session", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(inputHover, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ ok: true, hovered: true });
        expect(mouseEvents(fake).at(-1)).toEqual({ type: "mouseMoved", x: 122, y: 182 });
        const hover = fake.sent.find(
            (call) => call.method === "Runtime.callFunctionOn" &&
                String(call.params?.functionDeclaration).includes(":hover"),
        );

        expect(hover?.frameId).toBe(MID_FRAME);
    });

    it("reports that the element is not hovered when the page did not react", async () => {
        const { runtime } = setup({ hovered: false });
        const result = await runTool(inputHover, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ ok: false, hovered: false });
    });
});
