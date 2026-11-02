import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ElementRegistry,
    inputClick,
    inputHover,
    runTool,
    ToolRuntime,
} from "../src/tools/index.js";
import { crossSiteFake, MID_FRAME, pointerCounters, type CrossSiteWorld } from "./helpers/cross-site-fake.js";
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

async function withFakeTime<T>(run: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();

    const pending = run();

    await vi.advanceTimersByTimeAsync(30000);

    return pending;
}

afterEach(() => {
    vi.useRealTimers();
});

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

    it("installs the probe in the frame session before the press and removes it afterwards", async () => {
        const { fake, runtime } = setup();

        await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);

        const probes = fake.sent.filter(
            (call) => call.method === "Runtime.callFunctionOn" &&
                String(call.params?.functionDeclaration).includes("cdmProbe"),
        );
        const names = probes.map((call) => /cdmProbe\w+/.exec(String(call.params?.functionDeclaration))?.[0]);
        const press = fake.sent.findIndex((call) => call.params?.type === "mousePressed");

        expect(names[0]).toBe("cdmProbeInstall");
        expect(names.at(-1)).toBe("cdmProbeRemove");
        expect(probes.every((call) => call.frameId === MID_FRAME)).toBe(true);
        expect(fake.sent.indexOf(probes[0] as never)).toBeLessThan(press);
        expect(pointerCounters.get(fake)).toMatchObject({ installs: 1, removes: 1 });
    });

    it("retries the move until the frame receives it and then presses", async () => {
        const { fake, runtime } = setup({ dropMoves: 3 });
        const result = await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(mouseEvents(fake).map((event) => event.type)).toEqual([
            "mouseMoved", "mouseMoved", "mouseMoved", "mouseMoved", "mousePressed", "mouseReleased",
        ]);
        expect(pointerCounters.get(fake)).toMatchObject({ downs: 1, removes: 1 });
    });

    it("fails without pressing when the frame never receives the move", async () => {
        const { fake, runtime } = setup({ dropMoves: 1000 });
        const result = await withFakeTime(() =>
            runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime));

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("did not receive pointer input");
        expect(mouseEvents(fake).some((event) => event.type === "mousePressed")).toBe(false);
        expect(pointerCounters.get(fake)).toMatchObject({ installs: 1, removes: 1 });
    });

    it("measures the geometry again when the first measurement was taken before layout settled", async () => {
        const { fake, runtime } = setup({ staleUntilSettle: true });
        const result = await withFakeTime(() =>
            runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime));
        const events = mouseEvents(fake);

        expect(result.isError).not.toBe(true);
        expect(events[0]).toEqual({ type: "mouseMoved", x: 522, y: 182 });
        expect(events.at(-2)).toEqual({ type: "mousePressed", x: 122, y: 182 });
        expect(events.at(-1)).toEqual({ type: "mouseReleased", x: 122, y: 182 });
        expect(events.filter((event) => event.type === "mouseMoved").at(-1)).toEqual({
            type: "mouseMoved", x: 122, y: 182,
        });
    });

    it("keeps retrying a move that arrives after more than two seconds", async () => {
        const { fake, runtime } = setup({ moveDelayMs: 4000 });
        const result = await withFakeTime(() =>
            runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime));

        expect(result.isError).not.toBe(true);
        expect(pointerCounters.get(fake)).toMatchObject({ downs: 1, removes: 1 });
    });

    it("gives up after the budget and reports where the move landed", async () => {
        const { fake, runtime } = setup({ dropMoves: 1000, misrouteTop: true });
        const result = await withFakeTime(() =>
            runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime));
        const text = JSON.stringify(result.content);

        expect(result.isError).toBe(true);
        expect(text).toContain("Make sure the page is visible and not busy, then try again.\\nDiagnostics: ");
        expect(text).toMatch(/attempts=\d+ elapsedMs=\d+ point=\(122,182\) depth=1 frames=\(50,120,324,224\) dpr=2 landed=top:1/);
        expect(pointerCounters.get(fake)).toMatchObject({ installs: 1, removes: 1 });
    });

    it("releases and presses again once when the first press is dropped", async () => {
        const { fake, runtime } = setup({ dropDowns: 1 });
        const result = await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(mouseEvents(fake).map((event) => event.type)).toEqual([
            "mouseMoved", "mousePressed", "mouseReleased", "mousePressed", "mouseReleased",
        ]);
        expect(pointerCounters.get(fake)).toMatchObject({ downs: 1, removes: 1 });
    });

    it("does not press a second time when the first press arrives late", async () => {
        const { fake, runtime } = setup({ dropDowns: 1, lateDowns: true });
        const result = await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(mouseEvents(fake).filter((event) => event.type === "mousePressed")).toHaveLength(1);
        expect(pointerCounters.get(fake)).toMatchObject({ downs: 1, removes: 1 });
    });

    it("fails when no press is delivered after the single retry", async () => {
        const { fake, runtime } = setup({ dropDowns: 1000 });
        const result = await runTool(inputClick, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("did not receive the mouse press");
        expect(mouseEvents(fake).filter((event) => event.type === "mousePressed")).toHaveLength(2);
        expect(pointerCounters.get(fake)).toMatchObject({ removes: 1 });
    });

    it("verifies every press of a multi click", async () => {
        const { fake, runtime } = setup();

        await runTool(inputClick, { target: { uid: "1_1" }, clickCount: 2 }, extra(), runtime);

        expect(pointerCounters.get(fake)).toMatchObject({ downs: 2 });
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

    it("retries a dropped move before hovering and cleans the probe up", async () => {
        const { fake, runtime } = setup({ dropMoves: 2 });
        const result = await runTool(inputHover, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.structuredContent).toMatchObject({ ok: true, hovered: true });
        expect(mouseEvents(fake)).toHaveLength(5);
        expect(pointerCounters.get(fake)).toMatchObject({ installs: 1, removes: 1 });
    });

    it("fails when the frame never receives the hover move", async () => {
        const { runtime } = setup({ dropMoves: 1000 });
        const result = await withFakeTime(() =>
            runTool(inputHover, { target: { uid: "1_1" } }, extra(), runtime));

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("did not receive pointer input");
    });
});
