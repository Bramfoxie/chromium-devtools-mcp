import { FakeAccess } from "./fake-access.js";

export const CHILD_BOX = {
    content: [28, 33, 92, 33, 92, 67, 28, 67],
    padding: [22, 31, 98, 31, 98, 69, 22, 69],
    border : [20, 30, 100, 30, 100, 70, 20, 70],
    margin : [20, 30, 100, 30, 100, 70, 20, 70],
    width  : 80,
    height : 40,
};

export const OWNER_BOX = {
    content: [62, 132, 362, 132, 362, 332, 62, 332],
    padding: [55, 125, 369, 125, 369, 339, 55, 339],
    border : [50, 120, 374, 120, 374, 344, 50, 344],
    margin : [50, 120, 374, 120, 374, 344, 50, 344],
    width  : 324,
    height : 224,
};

export interface CrossSiteWorld {
    state?      : Record<string, unknown>;
    innerHit?   : Record<string, unknown>;
    outerHit?   : Record<string, unknown>;
    hovered?    : boolean;
    fileCount?  : number;
    selectRead? : Record<string, unknown>;
    selectWrite?: Record<string, unknown>;
    valueText?  : string;
}

export const MID_FRAME = "mid";

export function crossSiteFake(world: CrossSiteWorld = {}): FakeAccess {
    const fake = new FakeAccess();

    fake.frames = [
        { frameId: "main", url: "http://a.example/", name: "", isolated: false },
        { frameId: MID_FRAME, parentFrameId: "main", url: "http://b.example/", name: "", isolated: true },
    ];

    fake.respond = (_tab, method, params) => {
        const session = fake.sent.at(-1)?.frameId;
        const declaration = (params as { functionDeclaration?: unknown } | undefined)
            ?.functionDeclaration;
        const text = typeof declaration === "string" ? declaration : "";

        switch (method) {
            case "DOM.describeNode":
                return { node: { nodeName: "IFRAME", backendNodeId: 6 } };
            case "DOM.getFrameOwner":
                return { backendNodeId: 6, nodeId: 1 };
            case "DOM.getBoxModel":
                return {
                    model: (params as { backendNodeId?: unknown } | undefined)?.backendNodeId === 6
                        ? OWNER_BOX
                        : CHILD_BOX,
                };
            case "DOM.resolveNode":
                return { object: { objectId: session === undefined ? "obj-owner" : "obj-mid" } };
            case "DOM.scrollIntoViewIfNeeded":
            case "Emulation.setFocusEmulationEnabled":
            case "DOM.focus":
            case "DOM.setFileInputFiles":
            case "Input.dispatchMouseEvent":
            case "Input.dispatchKeyEvent":
            case "Input.insertText":
                return {};

            case "Runtime.evaluate": {
                const expression = (params as { expression?: unknown } | undefined)?.expression;

                if (expression === "location.href") {
                    return { result: { type: "string", value: "http://a.example/" } };
                }

                if (typeof expression === "string" && expression.includes("requestAnimationFrame")) {
                    return { result: { type: "boolean", value: true } };
                }

                if (typeof expression === "string" && expression.includes("innerWidth")) {
                    return {
                        result: {
                            type : "object",
                            value: { x: 0, y: 0, maxX: 0, maxY: 0, width: 800, height: 600 },
                        },
                    };
                }

                throw new Error(`unexpected evaluate ${String(expression)}`);
            }

            case "Runtime.callFunctionOn":
                if (text.includes("this.ownerDocument")) {
                    return { result: { type: "object", value: { kind: "hit", ...world.outerHit } } };
                }

                if (text.includes("elementFromPoint")) {
                    return { result: { type: "object", value: { kind: "hit", ...world.innerHit } } };
                }

                if (text.includes(":hover")) {
                    return { result: { type: "boolean", value: world.hovered ?? true } };
                }

                if (text.includes("scrollIntoView(")) {
                    return { result: { type: "string", value: "done" } };
                }

                if (text.includes("element.files")) {
                    return { result: { type: "object", value: { files: world.fileCount ?? 1 } } };
                }

                if (text.includes("element.value.length")) {
                    return {
                        result: {
                            type : "object",
                            value: { length: (world.valueText ?? "").length, text: world.valueText ?? "" },
                        },
                    };
                }

                if (text.includes("selectedOptions")) {
                    return { result: { type: "object", value: world.selectWrite } };
                }

                if (text.includes("element.options")) {
                    return { result: { type: "object", value: world.selectRead } };
                }

                return {
                    result: {
                        type : "object",
                        value: {
                            tag       : "button",
                            id        : "b",
                            classes   : [],
                            disabled  : false,
                            connected : true,
                            editable  : "none",
                            selectable: false,
                            fileInput : false,
                            ...world.state,
                        },
                    },
                };
            default:
                throw new Error(`unexpected CDP call ${method}`);
        }
    };

    return fake;
}
