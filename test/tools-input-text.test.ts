import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
    browserPlatform,
    clearPlatformCache,
    echoOf,
    ElementRegistry,
    inputKey,
    inputType,
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

interface TextWorld {
    state?   : Record<string, unknown>;
    value?   : { length: number; text: string };
    platform?: string;
}

function textFake(world: TextWorld = {}): FakeAccess {
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
            case "DOM.focus":
                return {};
            case "DOM.getBoxModel":
                return BOX_MODEL;
            case "Emulation.setFocusEmulationEnabled":
                return {};
            case "Input.insertText":
                return {};
            case "Input.dispatchKeyEvent":
                return {};

            case "Runtime.evaluate": {
                const expression = (params as { expression?: unknown })?.expression;

                if (expression === "location.href") {
                    return { result: { type: "string", value: "https://page.example/" } };
                }

                if (typeof expression === "string" && expression.includes("navigator.platform")) {
                    return { result: { type: "string", value: world.platform ?? "Win32" } };
                }

                throw new Error(`unexpected evaluate ${String(expression)}`);
            }

            case "Runtime.callFunctionOn": {
                const declaration = (params as { functionDeclaration?: unknown })
                    ?.functionDeclaration;

                if (
                    typeof declaration === "string" && declaration.includes("innerText")
                ) {
                    return {
                        result: {
                            type : "object",
                            value: world.value ?? { length: 5, text: "hello" },
                        },
                    };
                }

                return {
                    result: {
                        type : "object",
                        value: {
                            tag       : "input",
                            id        : "",
                            classes   : [],
                            disabled  : false,
                            connected : true,
                            editable  : "text",
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

describe("echoOf", () => {
    it("clips the echo to 50 characters and hides passwords", () => {
        expect(echoOf("short", false)).toBe("short");
        expect(echoOf("x".repeat(200), false)).toBe("x".repeat(50));
        expect(echoOf("secret", true)).toBeUndefined();
    });
});

describe("browserPlatform", () => {
    it("asks the page once per tab generation", async () => {
        clearPlatformCache();
        const fake = textFake({ platform: "MacIntel" });
        const { runtime } = runtimeWith(fake);

        await expect(browserPlatform(fake.asAccess(), runtime.elements, "tab1")).resolves.toBe(
            "MacIntel",
        );
        await expect(browserPlatform(fake.asAccess(), runtime.elements, "tab1")).resolves.toBe(
            "MacIntel",
        );
        expect(
            fake.sent.filter((entry) =>
                entry.method === "Runtime.evaluate" &&
                String((entry.params as { expression?: unknown })?.expression).includes(
                    "navigator.platform",
                ),
            ),
        ).toHaveLength(1);

        runtime.elements.nextGeneration("tab1");
        await expect(browserPlatform(fake.asAccess(), runtime.elements, "tab1")).resolves.toBe(
            "MacIntel",
        );
        expect(
            fake.sent.filter((entry) =>
                entry.method === "Runtime.evaluate" &&
                String((entry.params as { expression?: unknown })?.expression).includes(
                    "navigator.platform",
                ),
            ),
        ).toHaveLength(2);
        clearPlatformCache();
    });
});

describe("input_type", () => {
    it("focuses through DOM.focus and inserts fast without a delay", async () => {
        const { fake, runtime } = runtimeWith(textFake());

        const result = await runTool(
            inputType,
            { target: { uid: "1_1" }, text: "hello" },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            ok         : true,
            target     : { uid: "1_1", tag: "input" },
            valueLength: 5,
            typed      : "hello",
            contains   : true,
        });
        const order = fake.sent.map((entry) => entry.method);

        expect(order).toContain("DOM.focus");
        expect(order).toContain("Input.insertText");
        expect(order.filter((method) => method === "Input.dispatchMouseEvent")).toEqual([]);
        expect(fake.sent.find((entry) => entry.method === "DOM.focus")?.params).toEqual({
            backendNodeId: 101,
        });
        expect(fake.sent.find((entry) => entry.method === "Input.insertText")?.params).toEqual({
            text: "hello",
        });
    });

    it("types passwords correctly but never echoes them", async () => {
        const { fake, runtime } = runtimeWith(
            textFake({ state: { editable: "password" }, value: { length: 6, text: "s3cret" } }),
        );

        const result = await runTool(
            inputType,
            { target: { selector: "input[type=password]" }, text: "s3cret" },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            ok         : true,
            valueLength: 6,
            contains   : true,
        });
        expect(result.structuredContent).not.toHaveProperty("typed");
        expect(contentOf(result)).not.toContain("s3cret");
        expect(fake.sent.find((entry) => entry.method === "Input.insertText")?.params).toEqual({
            text: "s3cret",
        });
    });

    it("clears with select all and delete, and submits with Enter", async () => {
        const { fake, runtime } = runtimeWith(textFake());

        const result = await runTool(
            inputType,
            { target: { uid: "1_1" }, text: "hello", clear: true, submit: true },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        const keys = fake.sent.filter((entry) => entry.method === "Input.dispatchKeyEvent");

        expect(keys.length).toBeGreaterThan(2);
        expect(keys[0]?.params).toMatchObject({ type: "rawKeyDown", key: "Control" });
        expect(keys.find((entry) => entry.params?.commands !== undefined)?.params).toMatchObject({
            commands: ["selectAll"],
        });
        expect(keys[keys.length - 1]?.params).toMatchObject({ type: "keyUp", key: "Enter" });
    });

    it("dispatches per character key events with a delay, falling back for other scripts", async () => {
        const { fake, runtime } = runtimeWith(
            textFake({ value: { length: 2, text: "ae" } }),
        );
        const sleeps: number[] = [];
        const slow = new ToolRuntime({
            access  : fake.asAccess(),
            config  : managedConfig,
            elements: runtime.elements,
            clock   : { now: () => 0, sleep: async (ms) => void sleeps.push(ms) },
        });

        slow.tabs.refresh(
            [{
                targetId: "tab1",
                url     : "https://page.example/",
                title   : "t",
                owned   : true,
                created : true,
            }],
            "tab1",
        );
        const result = await runTool(
            inputType,
            { target: { uid: "1_1" }, text: "a\u00e9", delayMs: 5 },
            extra(),
            slow,
        );

        expect(result.isError).not.toBe(true);
        expect(sleeps).toEqual([5, 5]);

        const keys = fake.sent.filter((entry) => entry.method === "Input.dispatchKeyEvent");
        const inserts = fake.sent.filter((entry) => entry.method === "Input.insertText");

        expect(keys.map((entry) => entry.params?.type)).toEqual(["rawKeyDown", "char", "keyUp"]);
        expect(keys[0]?.params).toMatchObject({ key: "a", text: "a" });
        expect(inserts).toHaveLength(1);
        expect(inserts[0]?.params).toEqual({ text: "\u00e9" });
    });

    it("types into the focused element without a target", async () => {
        const { fake, runtime } = runtimeWith(textFake());

        const result = await runTool(inputType, { text: "hi" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ ok: true, typed: "hi", contains: true });
        expect(result.structuredContent).not.toHaveProperty("target");
        expect(fake.sent.map((entry) => entry.method)).not.toContain("DOM.focus");
    });

    it("refuses non editable targets, file inputs and disabled fields", async () => {
        const { runtime } = runtimeWith(textFake({ state: { tag: "div", editable: "none" } }));

        const div = await runTool(
            inputType,
            { target: { uid: "1_1" }, text: "hi" },
            extra(),
            runtime,
        );

        expect(div.isError).toBe(true);
        expect(contentOf(div)).toContain("cannot be typed into");

        const { runtime: files } = runtimeWith(
            textFake({ state: { tag: "input", editable: "none", fileInput: true } }),
        );
        const file = await runTool(
            inputType,
            { target: { uid: "1_1" }, text: "hi" },
            extra(),
            files,
        );

        expect(file.isError).toBe(true);
        expect(contentOf(file)).toContain("input_upload");

        const { runtime: off } = runtimeWith(textFake({ state: { disabled: true } }));
        const disabled = await runTool(
            inputType,
            { target: { uid: "1_1" }, text: "hi" },
            extra(),
            off,
        );

        expect(disabled.isError).toBe(true);
        expect(contentOf(disabled)).toContain("disabled");
    });

    it("reports when the page filtered the input", async () => {
        const { runtime } = runtimeWith(textFake({ value: { length: 0, text: "" } }));

        const result = await runTool(
            inputType,
            { target: { uid: "1_1" }, text: "hello" },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ ok: false, contains: false });
    });
});

describe("input_key", () => {
    it("presses a bare key as rawKeyDown, char and keyUp", async () => {
        const { fake, runtime } = runtimeWith(textFake());

        const result = await runTool(inputKey, { key: "Enter" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ ok: true, pressed: "Enter" });
        const keys = fake.sent.filter((entry) => entry.method === "Input.dispatchKeyEvent");

        expect(keys.map((entry) => entry.params?.type)).toEqual(["rawKeyDown", "char", "keyUp"]);
        expect(keys[0]?.params).toMatchObject({
            key                  : "Enter",
            code                 : "Enter",
            windowsVirtualKeyCode: 13,
            text                 : "\r",
        });
    });

    it("releases a held modifier when a mid-chord dispatch fails", async () => {
        const { fake, runtime } = runtimeWith(textFake());
        let calls = 0;

        fake.failSend = (_targetId, method) => {
            if (method !== "Input.dispatchKeyEvent") return undefined as never;

            calls += 1;

            if (calls === 2) return new Error("CDP gone");

            return undefined as never;
        };

        const result = await runTool(inputKey, { key: "Control+a" }, extra(), runtime);

        expect(result.isError).toBe(true);
        const keys = fake.sent.filter((entry) => entry.method === "Input.dispatchKeyEvent");
        const ups = keys.filter((entry) => entry.params?.type === "keyUp");

        expect(ups.length).toBeGreaterThanOrEqual(1);
        expect(ups[ups.length - 1]?.params).toMatchObject({ key: "Control" });
    });

    it("resolves ControlOrMeta from the browser platform, not the server", async () => {
        const { fake, runtime } = runtimeWith(textFake({ platform: "MacIntel" }));

        clearPlatformCache();
        const result = await runTool(inputKey, { key: "ControlOrMeta+C" }, extra(), runtime);

        expect(result.isError).not.toBe(true);
        const keys = fake.sent.filter((entry) => entry.method === "Input.dispatchKeyEvent");

        expect(keys[0]?.params).toMatchObject({ key: "Meta", modifiers: 4 });
        expect(keys[1]?.params).toMatchObject({ key: "c", commands: ["copy"], modifiers: 4 });
        clearPlatformCache();
    });

    it("focuses the target first and repeats the triple without the modifiers", async () => {
        const { fake, runtime } = runtimeWith(textFake());

        const result = await runTool(
            inputKey,
            { key: "b", target: { uid: "1_1" }, repeat: 3 },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            target: { uid: "1_1" },
            effect: "The key b was pressed 3 times.",
        });
        expect(fake.sent.map((entry) => entry.method)).toContain("DOM.focus");
        const keys = fake.sent.filter((entry) => entry.method === "Input.dispatchKeyEvent");

        expect(keys.map((entry) => entry.params?.type)).toEqual([
            "rawKeyDown",
            "char",
            "rawKeyDown",
            "char",
            "rawKeyDown",
            "char",
            "keyUp",
        ]);
    });

    it("rejects unknown keys with the accepted names", async () => {
        const { runtime } = runtimeWith(textFake());

        const result = await runTool(inputKey, { key: "Hyper" }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(contentOf(result)).toContain("Accepted key names");
    });
});

describe("text tools", () => {
    it("never sends a focus stealing call", async () => {
        const { fake, runtime } = runtimeWith(textFake());

        await runTool(inputType, { target: { uid: "1_1" }, text: "hi" }, extra(), runtime);
        await runTool(inputKey, { key: "Enter" }, extra(), runtime);
        expect(fake.sent.map((entry) => entry.method)).not.toContain("Page.bringToFront");
        expect(fake.sent.map((entry) => entry.method)).not.toContain("Target.activateTarget");
    });
});

describe("input_type and input_key in frames", () => {
    function framedTextFake(): FakeAccess {
        const fake = textFake({ value: { length: 4, text: "4111" } });
        const inner = fake.respond?.bind(fake);

        fake.frames = [
            { frameId: "main", url: "https://a.example/", name: "", isolated: false },
            {
                frameId      : "cross",
                parentFrameId: "main",
                url          : "https://b.example/",
                name         : "pay",
                isolated     : true,
            },
        ];

        fake.respond = (_targetId, method, params) => {
            if (method === "DOM.getDocument") return { root: { nodeId: 1 } };

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
                            frameId        : "cross",
                            contentDocument: { nodeId: 11 },
                        },
                    };
                }

                return { node: { backendNodeId: 4 } };
            }

            return inner?.(_targetId, method, params) as unknown;
        };

        return fake;
    }

    it("types into a field inside a frame selected by an iframe selector", async () => {
        const { fake, runtime } = runtimeWith(framedTextFake());

        fake.sent.length = 0;

        const result = await runTool(
            inputType,
            { target: { selector: "#card", frame: "#frame" }, text: "4111" },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ ok: true, contains: true });
        expect(fake.sent.map((call) => call.method)).toContain("DOM.focus");
        expect(fake.sent.map((call) => call.method)).toContain("Input.insertText");
    });

    it("presses a key into a field inside a frame", async () => {
        const { fake, runtime } = runtimeWith(framedTextFake());

        clearPlatformCache();
        fake.sent.length = 0;

        const result = await runTool(
            inputKey,
            { target: { selector: "#card", frame: "#frame" }, key: "Enter" },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ ok: true, pressed: "Enter" });
        expect(fake.sent.map((call) => call.method)).toContain("Input.dispatchKeyEvent");
    });
});
