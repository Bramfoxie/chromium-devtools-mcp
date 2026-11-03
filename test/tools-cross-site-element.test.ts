import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    ElementRegistry,
    inputKey,
    inputScroll,
    inputSelect,
    inputType,
    inputUpload,
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

function sessionsOf(fake: FakeAccess, method: string): Array<string | undefined> {
    return fake.sent.filter((call) => call.method === method).map((call) => call.frameId);
}

describe("input_select in a cross-site frame", () => {
    it("reads and writes the select through the frame session", async () => {
        const { fake, runtime } = setup({
            state     : { tag: "select", selectable: true },
            selectRead: {
                select  : true,
                multiple: false,
                options : [
                    { value: "a", label: "A", selected: true },
                    { value: "b", label: "B", selected: false },
                ],
            },
            selectWrite: { select: true, selected: [{ value: "b", label: "B" }] },
        });
        const result = await runTool(
            inputSelect,
            { target: { uid: "1_1" }, values: ["b"] },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ selected: [{ value: "b", label: "B" }] });
        const calls = sessionsOf(fake, "Runtime.callFunctionOn");

        expect(calls).toEqual([MID_FRAME, MID_FRAME, MID_FRAME]);
    });
});

describe("input_upload in a cross-site frame", () => {
    it("attaches the files on the frame session", async () => {
        const { fake, runtime } = setup({ state: { tag: "input", fileInput: true }, fileCount: 1 });
        const dir = await realpath(await mkdtemp(join(tmpdir(), "cdm-xsite-")));

        try {
            const file = join(dir, "a.txt");

            await writeFile(file, "alpha");
            const result = await runTool(
                inputUpload,
                { target: { uid: "1_1" }, files: [file] },
                extra(),
                runtime,
            );

            expect(result.isError).not.toBe(true);
            const attach = fake.sent.find((call) => call.method === "DOM.setFileInputFiles");

            expect(attach).toMatchObject({
                frameId: MID_FRAME,
                params : { backendNodeId: 101, files: [file] },
            });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe("input_type and input_key in a cross-site frame", () => {
    const field = { tag: "input", editable: "text" };

    it("focuses the field in the frame session and types through the tab", async () => {
        const { fake, runtime } = setup({ state: field, valueText: "hello" });
        const result = await runTool(
            inputType,
            { target: { uid: "1_1" }, text: "hello" },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({ ok: true, contains: true });
        expect(sessionsOf(fake, "DOM.focus")).toEqual([MID_FRAME]);
        expect(sessionsOf(fake, "Input.insertText")).toEqual([undefined]);
    });

    it("presses keys through the tab after focusing in the frame session", async () => {
        const { fake, runtime } = setup({ state: field });
        const result = await runTool(
            inputKey,
            { target: { uid: "1_1" }, key: "Enter" },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(sessionsOf(fake, "DOM.focus")).toEqual([MID_FRAME]);
        const keys = sessionsOf(fake, "Input.dispatchKeyEvent");

        expect(keys.length).toBeGreaterThan(0);
        expect(keys.every((session) => session === undefined)).toBe(true);
    });
});

describe("input_scroll with a target in a cross-site frame", () => {
    it("scrolls the element into view in the frame and reveals the iframe in the page", async () => {
        const { fake, runtime } = setup();
        const result = await runTool(inputScroll, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ ok: true, method: "intoView" });
        const intoView = fake.sent.find(
            (call) => call.method === "Runtime.callFunctionOn" &&
                String(call.params?.functionDeclaration).includes("scrollIntoView"),
        );
        const reveal = fake.sent.find(
            (call) => call.method === "DOM.scrollIntoViewIfNeeded" && call.frameId === undefined,
        );

        expect(intoView?.frameId).toBe(MID_FRAME);
        expect(reveal?.params).toMatchObject({ backendNodeId: 6 });
    });

    it("reports the scroll position of the frame", async () => {
        const { fake, runtime } = setup();

        await runTool(inputScroll, { target: { uid: "1_1" } }, extra(), runtime);

        const states = fake.sent.filter(
            (call) => call.method === "Runtime.evaluate" &&
                String(call.params?.expression).includes("innerWidth"),
        );

        expect(states.map((call) => call.frameId)).toEqual([MID_FRAME]);
    });
});
