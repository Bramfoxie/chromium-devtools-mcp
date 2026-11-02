import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    click,
    ElementRegistry,
    inputClick,
    inputHover,
    inputKey,
    inputScroll,
    inputSelect,
    inputType,
    inputUpload,
    runTool,
    screenshot,
    ToolRuntime,
    withElement,
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

function elementValue(state: Record<string, unknown>): Record<string, unknown> {
    return {
        tag       : "input",
        id        : "field",
        classes   : [],
        disabled  : false,
        connected : true,
        editable  : "text",
        selectable: false,
        fileInput : false,
        multiple  : false,
        kind      : "hit",
        files     : 1,
        ...state,
    };
}

function functionResult(declaration: string, state: Record<string, unknown>): unknown {
    const value = (inner: unknown) => ({ result: { type: "object", value: inner } });

    if (declaration.includes(":hover")) return value(true);

    if (declaration.includes("selectedOptions")) {
        return value({ select: true, selected: [{ value: "a", label: "A" }] });
    }

    if (declaration.includes("element.options")) {
        return value({
            select  : true,
            multiple: false,
            options : [{ value: "a", label: "A", selected: false }],
        });
    }

    if (declaration.includes("element.value.length")) return value({ length: 2, text: "hi" });

    return value(elementValue(state));
}

function worldFake(state: Record<string, unknown>, failMethod: string): FakeAccess {
    const fake = new FakeAccess();

    fake.respond = (_targetId, method, params) => {
        if (method === failMethod) throw new Error("browser call failed");

        switch (method) {
            case "DOM.getDocument":
                return { root: { nodeId: 1 } };
            case "DOM.querySelector":
                return { nodeId: 11 };
            case "DOM.resolveNode":
                return { object: { objectId: "obj-11" } };
            case "DOM.describeNode":
                return { node: { backendNodeId: 101 } };
            case "DOM.getBoxModel":
                return BOX_MODEL;
            case "Runtime.callFunctionOn":
                return functionResult(String(params?.functionDeclaration ?? ""), state);
            case "Page.getLayoutMetrics":
                return {
                    cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
                    cssContentSize   : { width: 800, height: 600 },
                };
            case "Page.captureScreenshot":
                return { data: "aGk=" };
            case "Runtime.evaluate":
                return String(params?.expression ?? "").includes("scrollX")
                    ? {
                        result: {
                            type : "object",
                            value: { x: 0, y: 0, maxX: 0, maxY: 0, width: 800, height: 600 },
                        },
                    }
                    : { result: { type: "string", value: "https://page.example/" } };
            default:
                return {};
        }
    };

    return fake;
}

function runtimeWith(fake: FakeAccess): ToolRuntime {
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

    return runtime;
}

function releases(fake: FakeAccess): string[] {
    return fake.sent
        .filter((call) => call.method === "Runtime.releaseObject")
        .map((call) => String(call.params?.objectId));
}

describe("withElement", () => {
    it("releases the remote object after the callback returns", async () => {
        const fake = worldFake({}, "none");
        const runtime = runtimeWith(fake);

        const value = await withElement(runtime, "tab1", { uid: "1_1" }, async (element) => element.objectId);

        expect(value).toBe("obj-11");
        expect(releases(fake)).toEqual(["obj-11"]);
    });

    it("releases the remote object when the callback throws and keeps the error", async () => {
        const fake = worldFake({}, "none");
        const runtime = runtimeWith(fake);

        await expect(
            withElement(runtime, "tab1", { uid: "1_1" }, async () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
        expect(releases(fake)).toEqual(["obj-11"]);
    });

    it("ignores a failing release", async () => {
        const fake = worldFake({}, "none");
        const runtime = runtimeWith(fake);
        const respond = fake.respond;

        fake.respond = (targetId, method, params) => {
            if (method === "Runtime.releaseObject") throw new Error("object is gone");

            return respond?.(targetId, method, params);
        };

        await expect(
            withElement(runtime, "tab1", { uid: "1_1" }, async () => "done"),
        ).resolves.toBe("done");
    });
});

interface ToolCase {
    name  : string;
    tool  : Parameters<typeof runTool>[0];
    args  : Record<string, unknown>;
    state : Record<string, unknown>;
    failOn: string;
}

let uploadFile = "";
let scratch = "";

beforeAll(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), "cdm-release-"));
    uploadFile = path.join(scratch, "upload.txt");
    await writeFile(uploadFile, "data");
});

afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
});

const TARGET = { uid: "1_1" };

const CALL = "Runtime.callFunctionOn";

function cases(): ToolCase[] {
    return [
        { name: "click", tool: click, args: { target: TARGET }, state: {}, failOn: CALL },
        { name: "input_click", tool: inputClick, args: { target: TARGET }, state: {}, failOn: CALL },
        { name: "input_hover", tool: inputHover, args: { target: TARGET }, state: {}, failOn: CALL },
        {
            name  : "input_type",
            tool  : inputType,
            args  : { target: TARGET, text: "hi" },
            state : {},
            failOn: CALL,
        },
        {
            name  : "input_key",
            tool  : inputKey,
            args  : { target: TARGET, key: "Enter" },
            state : {},
            failOn: CALL,
        },
        {
            name  : "input_select",
            tool  : inputSelect,
            args  : { target: TARGET, values: ["a"] },
            state : { tag: "select", selectable: true, editable: "none" },
            failOn: CALL,
        },
        { name: "input_scroll", tool: inputScroll, args: { target: TARGET }, state: {}, failOn: CALL },
        {
            name  : "input_upload",
            tool  : inputUpload,
            args  : { target: TARGET, files: [uploadFile] },
            state : { fileInput: true },
            failOn: CALL,
        },
        {
            name  : "screenshot",
            tool  : screenshot,
            args  : { target: TARGET },
            state : {},
            failOn: "Page.captureScreenshot",
        },
    ];
}

describe("tools release the resolved element", () => {
    for (const name of cases().map((entry) => entry.name)) {
        const entryOf = (): ToolCase =>
            cases().filter((entry) => entry.name === name)[0] as ToolCase;

        it(`${name} releases the remote object once it has finished`, async () => {
            const entry = entryOf();
            const fake = worldFake(entry.state, "none");
            const runtime = runtimeWith(fake);
            const result = await runTool(entry.tool, entry.args, extra(), runtime);

            expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
            expect(releases(fake)).toEqual(["obj-11"]);
        });

        it(`${name} releases the remote object when the browser call fails`, async () => {
            const entry = entryOf();
            const fake = worldFake(entry.state, entry.failOn);
            const runtime = runtimeWith(fake);
            const result = await runTool(entry.tool, entry.args, extra(), runtime);

            expect(result.isError).toBe(true);
            expect(releases(fake)).toEqual(["obj-11"]);
        });
    }
});
