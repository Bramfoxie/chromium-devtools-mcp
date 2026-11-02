import { FakeAccess } from "./fake-access.js";

export const CHILD_BOX = {
    content: [28, 33, 92, 33, 92, 67, 28, 67],
    padding: [22, 31, 98, 31, 98, 69, 22, 69],
    border : [20, 30, 100, 30, 100, 70, 20, 70],
    margin : [20, 30, 100, 30, 100, 70, 20, 70],
    width  : 80,
    height : 40,
};

export const STALE_OWNER_BOX = {
    content: [462, 132, 762, 132, 762, 332, 462, 332],
    padding: [455, 125, 769, 125, 769, 339, 455, 339],
    border : [450, 120, 774, 120, 774, 344, 450, 344],
    margin : [450, 120, 774, 120, 774, 344, 450, 344],
    width  : 324,
    height : 224,
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
    state?           : Record<string, unknown>;
    innerHit?        : Record<string, unknown>;
    outerHit?        : Record<string, unknown>;
    hovered?         : boolean;
    fileCount?       : number;
    selectRead?      : Record<string, unknown>;
    selectWrite?     : Record<string, unknown>;
    valueText?       : string;
    dropMoves?       : number;
    dropDowns?       : number;
    lateDowns?       : boolean;
    moveDelayMs?     : number;
    staleUntilSettle?: boolean;
    misrouteTop?     : boolean;
}

export interface PointerCounters {
    moves   : number;
    downs   : number;
    pending : number;
    installs: number;
    removes : number;
    topMoves: number;
}

export const MID_FRAME = "mid";

export const pointerCounters = new WeakMap<FakeAccess, PointerCounters>();

export function crossSiteFake(world: CrossSiteWorld = {}): FakeAccess {
    const fake = new FakeAccess();
    const counters: PointerCounters = {
        moves   : 0,
        downs   : 0,
        pending : 0,
        installs: 0,
        removes : 0,
        topMoves: 0,
    };
    let dropMoves = world.dropMoves ?? 0;
    let dropDowns = world.dropDowns ?? 0;
    let settled = world.staleUntilSettle !== true;
    let firstMoveAt: number | undefined;
    let topProbe = false;

    pointerCounters.set(fake, counters);

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
                        ? settled ? OWNER_BOX : STALE_OWNER_BOX
                        : CHILD_BOX,
                };
            case "DOM.resolveNode":
                return { object: { objectId: session === undefined ? "obj-owner" : "obj-mid" } };

            case "Input.dispatchMouseEvent": {
                const type = (params as { type?: unknown } | undefined)?.type;

                if (type === "mouseMoved") {
                    const at = params as { x?: number; y?: number };
                    const x = at.x ?? 0;
                    const y = at.y ?? 0;
                    const inside = world.staleUntilSettle !== true ||
                        (x >= 62 && x <= 362 && y >= 132 && y <= 332);

                    firstMoveAt ??= Date.now();

                    const early = Date.now() - firstMoveAt < (world.moveDelayMs ?? 0);

                    if (dropMoves > 0 || !inside || early) {
                        if (dropMoves > 0) dropMoves -= 1;
                        if (world.misrouteTop === true && topProbe) counters.topMoves += 1;
                    } else counters.moves += 1;
                }

                if (type === "mousePressed") {
                    if (dropDowns > 0) {
                        dropDowns -= 1;
                        if (world.lateDowns === true) counters.pending += 1;
                    } else counters.downs += 1;
                }

                return {};
            }

            case "DOM.scrollIntoViewIfNeeded":
            case "Emulation.setFocusEmulationEnabled":
            case "DOM.focus":
            case "DOM.setFileInputFiles":
            case "Input.dispatchKeyEvent":
            case "Input.insertText":
                return {};

            case "Runtime.evaluate": {
                const expression = (params as { expression?: unknown } | undefined)?.expression;

                if (expression === "location.href") {
                    return { result: { type: "string", value: "http://a.example/" } };
                }

                if (expression === "window.devicePixelRatio") {
                    return { result: { type: "number", value: 2 } };
                }

                if (typeof expression === "string" && expression.includes("requestAnimationFrame")) {
                    settled = true;
                    counters.downs += counters.pending;
                    counters.pending = 0;

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
                if (text.includes("cdmProbeInstall") && session !== MID_FRAME) {
                    topProbe = true;

                    return { result: { type: "boolean", value: true } };
                }

                if (text.includes("cdmProbeRemove") && session !== MID_FRAME) {
                    topProbe = false;

                    return { result: { type: "boolean", value: true } };
                }

                if (text.includes("cdmProbeRead") && session !== MID_FRAME) {
                    return { result: { type: "object", value: { moves: counters.topMoves, downs: 0 } } };
                }

                if (text.includes("cdmProbeInstall")) {
                    counters.installs += 1;

                    return { result: { type: "boolean", value: true } };
                }

                if (text.includes("cdmProbeRemove")) {
                    counters.removes += 1;

                    return { result: { type: "boolean", value: true } };
                }

                if (text.includes("cdmProbeRead")) {
                    return {
                        result: { type: "object", value: { moves: counters.moves, downs: counters.downs } },
                    };
                }

                if (text.includes("cdmProbeWait")) {
                    const args = (params as { arguments?: Array<{ value?: unknown }> }).arguments;
                    const kind = args?.[0]?.value;

                    return {
                        result: { type: "number", value: kind === "moves" ? counters.moves : counters.downs },
                    };
                }

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
