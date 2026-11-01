import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
    clipCssValue,
    cssInspect,
    DEFAULT_CSS_PROPERTIES,
    newTab,
    quadToRect,
    runTool,
    shapeComputed,
    shapeInherited,
    shapeMatchedRules,
    ToolRuntime,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

function setup(access?: FakeAccess) {
    const fake = access ?? new FakeAccess();
    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

    return { fake, runtime };
}

function rule(selector: string, declarations: Array<{ name: string; value: string; important?: boolean }>, origin = "regular") {
    return {
        rule: {
            selectorList: { selectors: [{ text: selector }] },
            origin,
            styleSheetId: "sheet-1",
            style       : { cssProperties: declarations },
        },
    };
}

describe("shapeComputed", () => {
    it("returns only the requested properties", () => {
        expect(
            shapeComputed(
                [
                    { name: "display", value: "block" },
                    { name: "color", value: "red" },
                ],
                ["color", "missing"],
            ),
        ).toEqual({ color: "red" });
    });

    it("covers layout, box, typography, color and visibility", () => {
        for (const name of ["display", "width", "margin-top", "font-size", "color", "visibility", "z-index", "cursor"]) {
            expect(DEFAULT_CSS_PROPERTIES).toContain(name);
        }

        expect(DEFAULT_CSS_PROPERTIES.length).toBeGreaterThanOrEqual(40);
    });
});

describe("shapeMatchedRules", () => {
    it("marks the last declaration of each property as winning and clips values", () => {
        const shaped = shapeMatchedRules(
            [
                rule("#main", [{ name: "color", value: "red" }]),
                rule(".box", [
                    { name: "color", value: "blue" },
                    { name: "color", value: "green" },
                    { name: "margin", value: "x".repeat(300) },
                ]),
            ],
            30,
        );

        expect(shaped).toHaveLength(2);
        expect(shaped[0]).toMatchObject({
            selector    : "#main",
            origin      : "regular",
            styleSheetId: "sheet-1",
            declarations: [{ name: "color", value: "red", important: false, winning: false }],
        });
        expect(shaped[1]?.declarations).toEqual([
            { name: "color", value: "blue", important: false, winning: false },
            { name: "color", value: "green", important: false, winning: true },
            { name: "margin", value: "x".repeat(200), important: false, winning: true },
        ]);
    });

    it("limits the number of rules", () => {
        expect(shapeMatchedRules([rule("a", []), rule("b", [])], 1)).toHaveLength(1);
    });
});

describe("shapeInherited", () => {
    it("keeps only inherited properties that are set", () => {
        expect(
            shapeInherited([
                {
                    matchedCSSRules: [
                        rule("body", [
                            { name: "color", value: "green" },
                            { name: "margin", value: "0" },
                        ]),
                    ],
                },
            ]),
        ).toEqual([{ property: "color", value: "green", selector: "body" }]);
    });
});

describe("clipCssValue", () => {
    it("clips values to 200 characters", () => {
        expect(clipCssValue("short")).toBe("short");
        expect(clipCssValue("x".repeat(201))).toHaveLength(200);
    });
});

describe("quadToRect", () => {
    it("reduces a quad to a rounded rectangle", () => {
        expect(quadToRect([10.4, 20.6, 30.2, 20.1, 30.9, 40.4, 10.2, 40.8])).toEqual({
            x     : 10,
            y     : 20,
            width : 21,
            height: 21,
        });
    });
});

describe("css_inspect", () => {
    function inspectFake() {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) => {
            switch (method) {
                case "DOM.resolveNode":
                    return { object: { objectId: "obj-7" } };
                case "DOM.describeNode":
                    return { node: { nodeId: 41, backendNodeId: 7 } };
                case "CSS.getComputedStyleForNode":
                    return {
                        computedStyle: [
                            { name: "display", value: "block" },
                            { name: "color", value: "rgb(255, 0, 0)" },
                        ],
                    };
                case "CSS.getMatchedStylesForNode":
                    return {
                        matchedCSSRules: [rule("#main", [{ name: "display", value: "block" }])],
                        inherited      : [
                            { matchedCSSRules: [rule("body", [{ name: "color", value: "green" }])] },
                        ],
                    };
                case "DOM.getBoxModel":
                    return {
                        model: {
                            content: [1, 2, 11, 2, 11, 12, 1, 12],
                            padding: [0, 1, 12, 1, 12, 13, 0, 13],
                            border : [0, 1, 12, 1, 12, 13, 0, 13],
                            margin : [-5, -5, 17, -5, 17, 18, -5, 18],
                        },
                    };
                default:
                    return {};
            }
        };

        return fake;
    }

    it("inspects an element uid with the default properties", async () => {
        const fake = inspectFake();
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        runtime.elements.nextGeneration("tab1");

        const [uid] = runtime.elements.assign("tab1", [{ backendNodeId: 7 }]);
        const result = await runTool(cssInspect, { target: { uid } }, extra(), runtime);

        expect(result.structuredContent).toEqual({
            computed    : { display: "block", color: "rgb(255, 0, 0)" },
            matchedRules: [
                {
                    selector    : "#main",
                    origin      : "regular",
                    styleSheetId: "sheet-1",
                    declarations: [{ name: "display", value: "block", important: false, winning: true }],
                },
            ],
            inherited: [{ property: "color", value: "green", selector: "body" }],
            box      : {
                content: { x: 1, y: 2, width: 10, height: 10 },
                padding: { x: 0, y: 1, width: 12, height: 12 },
                border : { x: 0, y: 1, width: 12, height: 12 },
                margin : { x: -5, y: -5, width: 22, height: 23 },
            },
        });
        expect(fake.sent.map((call) => call.method)).toEqual([
            "DOM.resolveNode",
            "DOM.describeNode",
            "DOM.enable",
            "CSS.enable",
            "CSS.getComputedStyleForNode",
            "CSS.getMatchedStylesForNode",
            "DOM.getBoxModel",
            "CSS.disable",
        ]);
    });

    it("honors custom properties and skips rules and box on request", async () => {
        const fake = inspectFake();
        const { runtime } = setup(fake);

        await runTool(newTab, {}, extra(), runtime);
        runtime.elements.nextGeneration("tab1");

        const [uid] = runtime.elements.assign("tab1", [{ backendNodeId: 7 }]);
        const result = await runTool(
            cssInspect,
            { target: { uid }, properties: ["color"], includeMatchedRules: false, includeBox: false },
            extra(),
            runtime,
        );

        expect(result.structuredContent).toMatchObject({
            computed    : { color: "rgb(255, 0, 0)" },
            matchedRules: [],
            inherited   : [],
            box         : null,
        });
        expect(fake.sent.map((call) => call.method)).not.toContain("CSS.getMatchedStylesForNode");
        expect(fake.sent.map((call) => call.method)).not.toContain("DOM.getBoxModel");
        expect(fake.sent.map((call) => call.method)).toContain("CSS.disable");
    });

    it("reports a stale uid without calling the browser", async () => {
        const { fake, runtime } = setup();

        await runTool(newTab, {}, extra(), runtime);
        const result = await runTool(cssInspect, { target: { uid: "5_5" } }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("stale");
        expect(fake.sent).toEqual([]);
    });

    it("names new_tab when no tab is selected", async () => {
        const { runtime } = setup();
        const result = await runTool(cssInspect, { target: { uid: "1_1" } }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("new_tab");
    });
});
