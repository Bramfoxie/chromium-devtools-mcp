import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
    describeOptions,
    ElementRegistry,
    inputSelect,
    matchSelectOptions,
    runTool,
    type SelectOption,
    SELECT_OPTIONS_LIMIT,
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

const OPTIONS: SelectOption[] = [
    { value: "red", label: "Red", selected: false },
    { value: "green", label: "Green", selected: true },
    { value: "blue", label: "Blue", selected: false },
];

interface SelectWorld {
    state?   : Record<string, unknown>;
    multiple?: boolean;
    options? : SelectOption[];
}

function selectFake(world: SelectWorld = {}): FakeAccess {
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
            case "DOM.getBoxModel":
                return BOX_MODEL;
            case "Emulation.setFocusEmulationEnabled":
                return {};
            case "Runtime.evaluate":
                return { result: { type: "string", value: "https://page.example/" } };

            case "Runtime.callFunctionOn": {
                const declaration = String(
                    (params as { functionDeclaration?: unknown })?.functionDeclaration ?? "",
                );

                if (declaration.includes("selectedOptions")) {
                    const indexes = ((params as { arguments?: Array<{ value?: unknown }> })
                        ?.arguments?.[1]?.value ?? []) as number[];
                    const options = world.options ?? OPTIONS;

                    return {
                        result: {
                            type : "object",
                            value: {
                                select  : true,
                                selected: indexes.map((index) => ({
                                    value: options[index]?.value ?? "",
                                    label: options[index]?.label ?? "",
                                })),
                            },
                        },
                    };
                }

                if (
                    declaration.includes("element.options") &&
                    declaration.includes("select: true")
                ) {
                    return {
                        result: {
                            type : "object",
                            value: {
                                select  : true,
                                multiple: world.multiple ?? false,
                                options : world.options ?? OPTIONS,
                            },
                        },
                    };
                }

                return {
                    result: {
                        type : "object",
                        value: {
                            tag       : "select",
                            id        : "color",
                            classes   : [],
                            disabled  : false,
                            connected : true,
                            editable  : "none",
                            selectable: true,
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

describe("matchSelectOptions", () => {
    it("matches by value, label and index", () => {
        expect(matchSelectOptions(OPTIONS, { values: ["blue"] }, false)).toEqual({ indexes: [2] });
        expect(matchSelectOptions(OPTIONS, { labels: ["Green"] }, false)).toEqual({ indexes: [1] });
        expect(matchSelectOptions(OPTIONS, { indexes: [0] }, false)).toEqual({ indexes: [0] });
    });

    it("matches several options of a multiple select and dedupes repeats", () => {
        expect(matchSelectOptions(OPTIONS, { values: ["red", "blue", "red"] }, true)).toEqual({
            indexes: [0, 2],
        });
    });

    it("refuses several options for a single select", () => {
        const matched = matchSelectOptions(OPTIONS, { values: ["red", "blue"] }, false);

        expect("error" in matched).toBe(true);
        if ("error" in matched) expect(matched.error).toContain("exactly one option");
    });

    it("lists the available options when nothing matches", () => {
        const byValue = matchSelectOptions(OPTIONS, { values: ["nope"] }, false);
        const byIndex = matchSelectOptions(OPTIONS, { indexes: [9] }, false);

        expect("error" in byValue).toBe(true);
        expect("error" in byIndex).toBe(true);

        if ("error" in byValue) {
            expect(byValue.error).toContain('value "nope"');
            expect(byValue.error).toContain('label="Green"');
        }

        if ("error" in byIndex) expect(byIndex.error).toContain("index 9");
    });
});

describe("describeOptions", () => {
    it("bounds the option list to 50 entries", () => {
        const options = Array.from({ length: SELECT_OPTIONS_LIMIT + 5 }, (_, index) => ({
            value   : `v${index}`,
            label   : `L${index}`,
            selected: false,
        }));

        expect(describeOptions([])).toBe("(no options)");
        expect(describeOptions(options)).toContain("... 5 more");
        expect(describeOptions(options)).not.toContain("v50");
    });
});

describe("input_select", () => {
    it("selects a single option by value and reports the selection", async () => {
        const { fake, runtime } = runtimeWith(selectFake());

        const result = await runTool(
            inputSelect,
            { target: { uid: "1_1" }, values: ["blue"] },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            ok      : true,
            target  : { uid: "1_1", tag: "select", id: "color" },
            selected: [{ value: "blue", label: "Blue" }],
        });
        const write = fake.sent.find((entry) => {
            const declaration = (entry.params as { functionDeclaration?: unknown })
                ?.functionDeclaration;

            return entry.method === "Runtime.callFunctionOn" &&
                String(declaration).includes("selectedOptions");
        });

        expect(write?.params).toMatchObject({
            arguments: [{ objectId: "obj-11" }, { value: [2] }],
        });
    });

    it("selects by label and by index", async () => {
        const { runtime } = runtimeWith(selectFake());

        const byLabel = await runTool(
            inputSelect,
            { target: { uid: "1_1" }, labels: ["Red"] },
            extra(),
            runtime,
        );

        expect(byLabel.structuredContent).toMatchObject({
            selected: [{ value: "red", label: "Red" }],
        });

        const byIndex = await runTool(
            inputSelect,
            { target: { uid: "1_1" }, indexes: [1] },
            extra(),
            runtime,
        );

        expect(byIndex.structuredContent).toMatchObject({
            selected: [{ value: "green", label: "Green" }],
        });
    });

    it("selects several options of a multiple select", async () => {
        const { runtime } = runtimeWith(selectFake({ multiple: true }));

        const result = await runTool(
            inputSelect,
            { target: { uid: "1_1" }, values: ["red", "blue"] },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            selected: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }],
        });
    });

    it("fails with the option list when nothing matches", async () => {
        const { fake, runtime } = runtimeWith(selectFake());

        const result = await runTool(
            inputSelect,
            { target: { uid: "1_1" }, values: ["nope"] },
            extra(),
            runtime,
        );

        expect(result.isError).toBe(true);
        expect(contentOf(result)).toContain("Available options");
        expect(contentOf(result)).toContain("Blue");
        expect(
            fake.sent.filter((entry) =>
                entry.method === "Runtime.callFunctionOn" &&
                String((entry.params as { functionDeclaration?: unknown })?.functionDeclaration)
                    .includes("selectedOptions"),
            ),
        ).toHaveLength(0);
    });

    it("refuses a non select element and requires exactly one matcher", async () => {
        const { runtime } = runtimeWith(selectFake({ state: { tag: "div", selectable: false } }));

        const div = await runTool(
            inputSelect,
            { target: { uid: "1_1" }, values: ["red"] },
            extra(),
            runtime,
        );

        expect(div.isError).toBe(true);
        expect(contentOf(div)).toContain("not a select");

        const { runtime: multi } = runtimeWith(selectFake());
        const both = await runTool(
            inputSelect,
            { target: { uid: "1_1" }, values: ["red"], labels: ["Red"] },
            extra(),
            multi,
        );

        expect(both.isError).toBe(true);
        expect(contentOf(both)).toContain("exactly one of values");
    });

    it("never sends a focus stealing call", async () => {
        const { fake, runtime } = runtimeWith(selectFake());

        await runTool(inputSelect, { target: { uid: "1_1" }, values: ["red"] }, extra(), runtime);
        expect(fake.sent.map((entry) => entry.method)).not.toContain("Page.bringToFront");
        expect(fake.sent.map((entry) => entry.method)).not.toContain("Target.activateTarget");
    });
});

describe("input_select in shadow roots", () => {
    it("selects an option of a select inside a shadow root", async () => {
        const fake = selectFake();
        const inner = fake.respond?.bind(fake);

        fake.respond = (_targetId, method, params) => {
            if (method === "DOM.querySelector") {
                const selector = (params as { selector?: unknown })?.selector;

                if (selector === "my-app") return { nodeId: 13 };

                return { nodeId: 15 };
            }

            if (method === "DOM.describeNode") {
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
            }

            return inner?.(_targetId, method, params);
        };

        const { runtime } = runtimeWith(fake);
        const result = await runTool(
            inputSelect,
            { target: { selector: "my-app >>> select" }, values: ["red"] },
            extra(),
            runtime,
        );

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            ok      : true,
            selected: [{ value: "red", label: "Red" }],
        });
    });
});
