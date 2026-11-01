import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import {
    coveredMessage,
    describeTarget,
    elementState,
    ensureActionable,
    hitTest,
    readBox,
    ToolError,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";

const element = { backendNodeId: 7, objectId: "obj-7" };

const BOX_MODEL = {
    model: {
        content: [10, 20, 110, 20, 110, 70, 10, 70],
        padding: [10, 20, 110, 20, 110, 70, 10, 70],
        border : [10, 20, 110, 20, 110, 70, 10, 70],
        margin : [10, 20, 110, 20, 110, 70, 10, 70],
    },
};

function stateValue(overrides: Record<string, unknown> = {}) {
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
                ...overrides,
            },
        },
    };
}

function hitValue(overrides: Record<string, unknown> = {}) {
    return { result: { type: "object", value: { kind: "hit", ...overrides } } };
}

function actionableFake(overrides: {
    state?      : Record<string, unknown>;
    hit?        : Record<string, unknown>;
    box?        : unknown;
    scrollFails?: boolean;
}): FakeAccess {
    const fake = new FakeAccess();

    fake.respond = (_targetId, method, params) => {
        if (method === "Runtime.callFunctionOn") {
            const declaration = (params as { functionDeclaration?: unknown })?.functionDeclaration;

            if (typeof declaration === "string" && declaration.includes("elementFromPoint")) {
                return hitValue(overrides.hit);
            }

            return stateValue(overrides.state);
        }

        if (method === "DOM.scrollIntoViewIfNeeded") {
            if (overrides.scrollFails === true) {
                throw new RpcError(ErrorCode.cdpError, "No node with given id found.");
            }

            return {};
        }

        if (method === "DOM.getBoxModel") return overrides.box ?? BOX_MODEL;

        throw new Error(`unexpected CDP call ${method}`);
    };

    return fake;
}

describe("describeTarget", () => {
    it("joins the tag, id and classes", () => {
        expect(describeTarget({ tag: "div", id: "", classes: [] })).toBe("div");
        expect(describeTarget({ tag: "div", id: "menu", classes: ["open", "dark"] })).toBe(
            "div#menu.open.dark",
        );
    });

    it("names the covering element and the way through it in the message", () => {
        expect(coveredMessage({ tag: "div", id: "menu", classes: [] }, "click")).toContain(
            "div#menu",
        );
        expect(coveredMessage({ tag: "div", id: "", classes: [] }, "hover")).toContain(
            "Pass force: true to hover through it.",
        );
    });
});

describe("elementState", () => {
    it("reads the state of a connected element", async () => {
        const fake = actionableFake({});

        await expect(elementState(fake.asAccess(), "tab1", element)).resolves.toEqual({
            tag       : "button",
            id        : "save",
            classes   : ["primary"],
            disabled  : false,
            connected : true,
            editable  : "none",
            selectable: false,
            fileInput : false,
        });
    });

    it("passes the element as the first argument as well as this", async () => {
        const fake = actionableFake({});

        await elementState(fake.asAccess(), "tab1", element);
        const call = fake.sent.find((entry) => entry.method === "Runtime.callFunctionOn");

        expect(call?.params).toMatchObject({
            objectId     : "obj-7",
            arguments    : [{ objectId: "obj-7" }],
            returnByValue: true,
        });
    });

    it("rejects an unexpected browser response", async () => {
        const fake = new FakeAccess();

        fake.respond = () => ({ result: { type: "undefined" } });

        await expect(elementState(fake.asAccess(), "tab1", element)).rejects.toThrow(
            "unexpected element state",
        );
    });
});

describe("hitTest", () => {
    it("passes the element and the point as the function arguments", async () => {
        const fake = actionableFake({});

        await expect(hitTest(fake.asAccess(), "tab1", element, { x: 12, y: 34 })).resolves.toEqual({
            kind: "hit",
        });
        const call = fake.sent.find((entry) => entry.method === "Runtime.callFunctionOn");

        expect(call?.params).toMatchObject({
            arguments: [{ objectId: "obj-7" }, { value: 12 }, { value: 34 }],
        });
    });

    it("reports the covering element", async () => {
        const fake = actionableFake({
            hit: { kind: "covered", tag: "div", id: "overlay", classes: ["modal"] },
        });

        await expect(hitTest(fake.asAccess(), "tab1", element, { x: 12, y: 34 })).resolves.toEqual({
            kind: "covered",
            by  : { tag: "div", id: "overlay", classes: ["modal"] },
        });
    });
});

describe("ensureActionable", () => {
    it("scrolls the element into view and returns its state and box", async () => {
        const fake = actionableFake({});

        await expect(
            ensureActionable(fake.asAccess(), "tab1", element, { checkDisabled: true }),
        ).resolves.toEqual({
            state: {
                tag       : "button",
                id        : "save",
                classes   : ["primary"],
                disabled  : false,
                connected : true,
                editable  : "none",
                selectable: false,
                fileInput : false,
            },
            box: { x: 10, y: 20, width: 100, height: 50 },
        });
        expect(fake.sent.map((entry) => entry.method)).toEqual([
            "Runtime.callFunctionOn",
            "DOM.scrollIntoViewIfNeeded",
            "DOM.getBoxModel",
        ]);
    });

    it("refuses a detached element before touching the box", async () => {
        const fake = actionableFake({ state: { connected: false } });

        await expect(
            ensureActionable(fake.asAccess(), "tab1", element, { checkDisabled: true }),
        ).rejects.toThrow("no longer attached");
        expect(fake.sent.map((entry) => entry.method)).toEqual(["Runtime.callFunctionOn"]);
    });

    it("refuses a disabled element only when the check is on", async () => {
        const fake = actionableFake({ state: { disabled: true } });

        await expect(
            ensureActionable(fake.asAccess(), "tab1", element, { checkDisabled: true }),
        ).rejects.toThrow("disabled");
        await expect(
            ensureActionable(fake.asAccess(), "tab1", element, { checkDisabled: false }),
        ).resolves.toMatchObject({ box: { x: 10, y: 20, width: 100, height: 50 } });
    });

    it("refuses an element that cannot be scrolled into view", async () => {
        const fake = actionableFake({ scrollFails: true });

        await expect(
            ensureActionable(fake.asAccess(), "tab1", element, { checkDisabled: true }),
        ).rejects.toThrow("cannot be scrolled into view");
    });

    it("refuses an element without a box", async () => {
        const fake = actionableFake({
            box: {
                model: {
                    content: [10, 20, 10, 20, 10, 20, 10, 20],
                    padding: [10, 20, 10, 20, 10, 20, 10, 20],
                    border : [10, 20, 10, 20, 10, 20, 10, 20],
                    margin : [10, 20, 10, 20, 10, 20, 10, 20],
                },
            },
        });

        await expect(
            ensureActionable(fake.asAccess(), "tab1", element, { checkDisabled: true }),
        ).rejects.toThrow("no box on the page");
    });

    it("reports a covered element by tag, id and classes instead of acting", async () => {
        const fake = actionableFake({
            hit: { kind: "covered", tag: "div", id: "overlay", classes: ["modal"] },
        });

        const failure = ensureActionable(fake.asAccess(), "tab1", element, {
            checkDisabled: true,
            hitTest      : { point: { x: 60, y: 45 }, verb: "click" },
        });

        await expect(failure).rejects.toThrow("div#overlay.modal");
        await expect(failure).rejects.toThrow(ToolError);
    });

    it("refuses a point outside the viewport", async () => {
        const fake = actionableFake({ hit: { kind: "outside" } });

        await expect(
            ensureActionable(fake.asAccess(), "tab1", element, {
                checkDisabled: true,
                hitTest      : { point: { x: 6000, y: 45 }, verb: "click" },
            }),
        ).rejects.toThrow("outside the page viewport");
    });
});

describe("readBox", () => {
    it("reads a fresh box without scrolling", async () => {
        const fake = actionableFake({});

        await expect(readBox(fake.asAccess(), "tab1", element)).resolves.toEqual({
            x     : 10,
            y     : 20,
            width : 100,
            height: 50,
        });
        expect(fake.sent.map((entry) => entry.method)).toEqual(["DOM.getBoxModel"]);
    });

    it("refuses a hidden element", async () => {
        const fake = new FakeAccess();

        fake.respond = (targetId, method) => {
            if (method === "DOM.getBoxModel") {
                throw new RpcError(ErrorCode.cdpError, "No box model.");
            }

            throw new Error(`unexpected CDP call ${method} on ${targetId}`);
        };

        await expect(readBox(fake.asAccess(), "tab1", element)).rejects.toThrow(
            "no box on the page",
        );
    });
});
