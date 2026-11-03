import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import {
    coveredMessage,
    describeTarget,
    elementState,
    ensureActionable,
    HIT_EXPRESSION,
    hitTest,
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
                multiple  : true,
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
            multiple  : true,
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

    it("marks the call as local to the frame and does not retry through the tab", async () => {
        const fake = actionableFake({});

        await expect(
            hitTest(fake.asAccess(), "tab1", element, { x: 12, y: 34 }, true),
        ).resolves.toEqual({ kind: "hit" });
        const call = fake.sent.find((entry) => entry.method === "Runtime.callFunctionOn");

        expect(call?.params).toMatchObject({
            arguments: [{ objectId: "obj-7" }, { value: 12 }, { value: 34 }, { value: true }],
        });
    });

    it("surfaces a script error of a local hit test instead of probing the tab", async () => {
        const fake = new FakeAccess();

        fake.respond = () => ({ result: { type: "object", subtype: "error" } });

        await expect(
            hitTest(fake.asAccess(), "tab1", element, { x: 12, y: 34 }, true),
        ).rejects.toThrow("unexpected hit test result");
        expect(fake.sent.some((entry) => entry.method === "Runtime.evaluate")).toBe(false);
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

    it("maps a hidden verdict to the hidden message", async () => {
        const fake = actionableFake({ hit: { kind: "hidden" } });

        await expect(hitTest(fake.asAccess(), "tab1", element, { x: 12, y: 34 })).rejects.toThrow(
            "no box on the page",
        );
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
                multiple  : true,
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
});

describe("hitTest piercing", () => {
    function piercingFake(stack: Array<{ tag: string; id: string; frame: boolean }>): FakeAccess {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method, params) => {
            if (method === "Runtime.callFunctionOn") {
                throw new RpcError(ErrorCode.cdpError, "Uncaught SecurityError");
            }

            if (method === "Runtime.evaluate") {
                const expression = (params as { expression?: unknown })?.expression;

                if (typeof expression === "string" && expression.includes("elementsFromPoint")) {
                    return { result: { type: "object", subtype: "array", value: stack } };
                }
            }

            throw new Error(`unexpected CDP call ${method}`);
        };

        return fake;
    }

    it("treats a top-level iframe hit as a hit on the isolated element", async () => {
        const fake = piercingFake([
            { tag: "iframe", id: "cross", frame: true },
            { tag: "body", id: "", frame: false },
        ]);

        await expect(hitTest(fake.asAccess(), "tab1", element, { x: 12, y: 34 })).resolves.toEqual({
            kind: "hit",
        });
    });

    it("reports a top-level overlay as covering the isolated element", async () => {
        const fake = piercingFake([
            { tag: "div", id: "overlay", frame: false },
            { tag: "iframe", id: "cross", frame: true },
        ]);

        await expect(hitTest(fake.asAccess(), "tab1", element, { x: 12, y: 34 })).resolves.toEqual({
            kind: "covered",
            by  : { tag: "div", id: "overlay", classes: [] },
        });
    });

    it("reports an empty stack as outside", async () => {
        const fake = piercingFake([]);

        await expect(hitTest(fake.asAccess(), "tab1", element, { x: 12, y: 34 })).resolves.toEqual({
            kind: "outside",
        });
    });

    it("passes non-CDP failures through instead of guessing", async () => {
        const fake = new FakeAccess();

        fake.failSend = () => new RpcError(ErrorCode.cdpTimeout, "CDP request timed out.");

        await expect(hitTest(fake.asAccess(), "tab1", element, { x: 12, y: 34 })).rejects.toMatchObject(
            { code: ErrorCode.cdpTimeout },
        );
    });
});

describe("hitTest cross-origin fallback", () => {
    it("falls back when the object belongs to another process", async () => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) => {
            if (method === "Runtime.callFunctionOn") {
                throw new RpcError(ErrorCode.cdpError, "Could not find object with given id");
            }

            return {
                result: { type: "object", subtype: "array", value: [{ tag: "iframe", id: "x", frame: true }] },
            };
        };

        await expect(hitTest(fake.asAccess(), "tab1", element, { x: 1, y: 2 })).resolves.toEqual({
            kind: "hit",
        });
    });

    it("rethrows errors that are not isolated frame errors", async () => {
        for (const error of [
            new RpcError(ErrorCode.cdpError, "Invalid parameters"),
            new RpcError(ErrorCode.browserClosed, "The browser closed."),
            new Error("cancelled"),
        ]) {
            const fake = new FakeAccess();

            fake.respond = (_targetId, method) => {
                if (method === "Runtime.callFunctionOn") throw error;

                throw new Error("the isolated fallback must not run: " + method);
            };

            await expect(
                hitTest(fake.asAccess(), "tab1", element, { x: 1, y: 2 }),
            ).rejects.toBe(error);
        }
    });

    it("falls back to the top-level stack when the script throws a SecurityError", async () => {
        const fake = new FakeAccess();
        let calls = 0;

        fake.respond = (targetId, method, params) => {
            void targetId;

            if (method === "Runtime.callFunctionOn") {
                return { result: { type: "object", subtype: "error" } };
            }

            if (method === "Runtime.evaluate") {
                calls += 1;

                return {
                    result: {
                        type   : "object",
                        subtype: "array",
                        value  : [{ tag: "iframe", id: "cross", frame: true }],
                    },
                };
            }

            throw new Error("unexpected " + method + " " + JSON.stringify(params));
        };

        await expect(hitTest(fake.asAccess(), "tab1", element, { x: 12, y: 34 })).resolves.toEqual({
            kind: "hit",
        });
        expect(calls).toBe(1);
    });
});

interface HitScriptVerdict {
    kind    : string;
    tag?    : string;
    id?     : string;
    classes?: string[];
}

interface FakeStyle {
    visibility: string;
    display   : string;
}

interface FakeShadowHost {
    host: FakeElement | null;
}

class FakeDocument {
    defaultView: FakeView | null = null;
    topHit     : FakeElement | null = null;

    elementFromPoint(): FakeElement | null {
        return this.topHit;
    }
}

class FakeView {
    parent  : FakeView;
    document: FakeDocument;

    constructor(document: FakeDocument) {
        this.document = document;
        this.parent = this;
    }

    getComputedStyle(element: FakeElement): FakeStyle {
        return element.style;
    }
}

class FakeElement {
    localName    : string;
    id           : string;
    classList    : string[];
    ownerDocument: FakeDocument;
    parentNode   : FakeElement | null;
    rootHost     : FakeElement | null;
    shadowRoot   : FakeDocument | null;
    style        : FakeStyle;
    rects        : number;
    children     : FakeElement[];

    constructor(document: FakeDocument, tag: string, id = "", classes: string[] = []) {
        this.localName = tag;
        this.id = id;
        this.classList = classes;
        this.ownerDocument = document;
        this.parentNode = null;
        this.rootHost = null;
        this.shadowRoot = null;
        this.style = { visibility: "visible", display: "block" };
        this.rects = 1;
        this.children = [];
    }

    append(child: FakeElement): void {
        child.parentNode = this;
        this.children.push(child);
    }

    getClientRects(): unknown[] {
        return Array.from({ length: this.rects });
    }

    getRootNode(): FakeShadowHost {
        return { host: this.rootHost };
    }

    contains(other: FakeElement | null): boolean {
        if (other === null) return false;

        if (other === this) return true;

        return this.children.some((child) => child.contains(other));
    }
}

function hitFixture(): FakeDocument {
    const document = new FakeDocument();
    const view = new FakeView(document);

    document.defaultView = view;

    return document;
}

function runHitExpression(
    target: FakeElement,
    x = 60,
    y = 45,
    local = false,
): HitScriptVerdict {
    const value: unknown = runInNewContext(`(${HIT_EXPRESSION})(element, x, y, local)`, {
        element: target,
        x,
        y,
        local,
    });

    return JSON.parse(JSON.stringify(value)) as HitScriptVerdict;
}

describe("HIT_EXPRESSION in a real JavaScript engine", () => {
    it("treats a hit on a strict descendant as a hit", () => {
        const document = hitFixture();
        const target = new FakeElement(document, "button", "save", ["primary"]);
        const inner = new FakeElement(document, "span", "inner");

        target.append(inner);
        document.topHit = inner;

        expect(runHitExpression(target)).toEqual({ kind: "hit" });
    });

    it("treats a closed shadow host as a hit", () => {
        const document = hitFixture();
        const host = new FakeElement(document, "div", "widget");
        const target = new FakeElement(document, "button", "save");

        target.rootHost = host;
        document.topHit = host;

        expect(runHitExpression(target)).toEqual({ kind: "hit" });
    });

    it("reports a light-DOM ancestor as covering", () => {
        const document = hitFixture();
        const parent = new FakeElement(document, "div", "panel");
        const target = new FakeElement(document, "button", "save");

        parent.append(target);
        document.topHit = parent;

        expect(runHitExpression(target)).toEqual({
            kind   : "covered",
            tag    : "div",
            id     : "panel",
            classes: [],
        });
    });

    it("stops at the frame root when the parent window is cross-origin and the call is local", () => {
        const document = hitFixture();
        const target = new FakeElement(document, "button", "save");
        const view = document.defaultView as FakeView;

        view.parent = new FakeView(new FakeDocument());
        Object.defineProperty(view.parent, "document", {
            get() {
                throw new Error("SecurityError");
            },
        });
        document.topHit = target;

        expect(runHitExpression(target, 60, 45, true)).toEqual({ kind: "hit" });
        expect(() => runHitExpression(target, 60, 45, false)).toThrow("SecurityError");
    });

    it("reports a hidden target as hidden", () => {
        const document = hitFixture();
        const target = new FakeElement(document, "button", "save");

        target.rects = 0;
        document.topHit = target;

        expect(runHitExpression(target)).toEqual({ kind: "hidden" });
    });
});
