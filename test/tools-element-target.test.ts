import { describe, expect, it } from "vitest";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import {
    boxOf,
    ElementRegistry,
    elementTargetSchema,
    MAX_UIDS_PER_TAB,
    rectOfQuad,
    resolveElement,
    revealElement,
    STALE_UID_MESSAGE,
    ToolError,
} from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";

const BOX = {
    model: {
        content: [10, 20, 30, 20, 30, 40, 10, 40],
        padding: [10, 20, 30, 20, 30, 40, 10, 40],
        border : [10, 20, 30, 20, 30, 40, 10, 40],
        margin : [10, 20, 30, 20, 30, 40, 10, 40],
    },
};

describe("elementTargetSchema", () => {
    it("accepts exactly one of uid or selector", () => {
        expect(elementTargetSchema.safeParse({ uid: "1_2" }).success).toBe(true);
        expect(elementTargetSchema.safeParse({ selector: "#main" }).success).toBe(true);
    });

    it("rejects both or neither with a clear message", () => {
        const both = elementTargetSchema.safeParse({ uid: "1_1", selector: "a" });
        const neither = elementTargetSchema.safeParse({});

        expect(both.success).toBe(false);
        expect(neither.success).toBe(false);

        if (!both.success) {
            expect(both.error.issues[0]?.message).toContain("exactly one of uid or selector");
        }

        if (!neither.success) {
            expect(neither.error.issues[0]?.message).toContain("exactly one of uid or selector");
        }
    });

    it("rejects an empty uid and an overlong selector", () => {
        expect(elementTargetSchema.safeParse({ uid: "" }).success).toBe(false);
        expect(elementTargetSchema.safeParse({ selector: "" }).success).toBe(false);
        expect(elementTargetSchema.safeParse({ selector: "x".repeat(1025) }).success).toBe(false);
        expect(elementTargetSchema.safeParse({ selector: "x".repeat(1024) }).success).toBe(true);
    });
});

describe("ElementRegistry", () => {
    it("assigns uids of the current generation and reads them back", () => {
        const elements = new ElementRegistry();

        elements.nextGeneration("tab1");
        const uids = elements.assign("tab1", [{ backendNodeId: 7 }, { backendNodeId: 9, frameId: "f" }]);

        expect(uids).toEqual(["1_1", "1_2"]);
        expect(elements.generation("tab1")).toBe(1);
        expect(elements.lookup("tab1", "1_1")).toEqual({ backendNodeId: 7 });
        expect(elements.lookup("tab1", "1_2")).toEqual({ backendNodeId: 9, frameId: "f" });
    });

    it("keeps generations separate per tab", () => {
        const elements = new ElementRegistry();

        elements.nextGeneration("tab1");
        elements.nextGeneration("tab1");
        elements.nextGeneration("tab2");
        const uids = elements.assign("tab1", [{ backendNodeId: 1 }]);

        expect(uids).toEqual(["2_1"]);
        expect(elements.generation("tab2")).toBe(1);
        expect(elements.lookup("tab2", "2_1")).toBeUndefined();
    });

    it("reports uids of an older generation as stale", () => {
        const elements = new ElementRegistry();

        elements.nextGeneration("tab1");
        elements.assign("tab1", [{ backendNodeId: 1 }]);
        elements.nextGeneration("tab1");
        elements.assign("tab1", [{ backendNodeId: 2 }]);

        expect(elements.lookup("tab1", "1_1")).toBeUndefined();
        expect(elements.lookup("tab1", "2_1")).toEqual({ backendNodeId: 2 });
    });

    it("reports unknown tabs, unknown uids and malformed uids as stale", () => {
        const elements = new ElementRegistry();

        elements.nextGeneration("tab1");
        elements.assign("tab1", [{ backendNodeId: 1 }]);

        expect(elements.lookup("tab2", "1_1")).toBeUndefined();
        expect(elements.lookup("tab1", "1_9")).toBeUndefined();
        expect(elements.lookup("tab1", "nope")).toBeUndefined();
        expect(elements.lookup("tab1", "")).toBeUndefined();
    });

    it("bounds the uid map of a tab and drops everything on reset", () => {
        const elements = new ElementRegistry();
        const nodes = Array.from({ length: MAX_UIDS_PER_TAB + 5 }, (_, index) => ({
            backendNodeId: index + 1,
        }));
        const uids = elements.assign("tab1", nodes);

        expect(uids.slice(0, MAX_UIDS_PER_TAB).every((uid) => uid !== undefined)).toBe(true);
        expect(uids.slice(MAX_UIDS_PER_TAB)).toEqual(Array(5).fill(undefined));
        expect(elements.lookup("tab1", `0_${MAX_UIDS_PER_TAB}`)).toBeDefined();
        elements.reset();

        expect(elements.lookup("tab1", `0_1`)).toBeUndefined();
        expect(elements.generation("tab1")).toBe(0);
    });
});

describe("resolveElement", () => {
    function setup() {
        const fake = new FakeAccess();
        const elements = new ElementRegistry();

        fake.respond = (_targetId, method, params) => {
            switch (method) {
                case "DOM.getDocument":
                    return { root: { nodeId: 1 } };
                case "DOM.querySelector":
                    return { nodeId: params?.selector === "#missing" ? 0 : 41 };
                case "DOM.resolveNode":
                    return { object: { objectId: "obj-1" } };
                case "DOM.describeNode":
                    return { node: { nodeId: 41, backendNodeId: 7 } };
                default:
                    throw new Error(`unexpected CDP call ${method}`);
            }
        };

        return { fake, elements };
    }

    it("resolves a uid through DOM.resolveNode with the backend node id", async () => {
        const { fake, elements } = setup();

        elements.nextGeneration("tab1");
        const [uid] = elements.assign("tab1", [{ backendNodeId: 7, frameId: "f1" }]);
        const resolved = await resolveElement(fake.asAccess(), elements, "tab1", { uid });

        expect(resolved).toEqual({ backendNodeId: 7, frameId: "f1", objectId: "obj-1" });
        expect(fake.sent).toEqual([
            {
                targetId : "tab1",
                method   : "DOM.resolveNode",
                params   : { backendNodeId: 7 },
                timeoutMs: undefined,
            },
        ]);
    });

    it("rejects a stale uid without calling the browser", async () => {
        const { fake, elements } = setup();

        elements.nextGeneration("tab1");
        elements.assign("tab1", [{ backendNodeId: 7 }]);
        elements.nextGeneration("tab1");
        const failure = await resolveElement(fake.asAccess(), elements, "tab1", { uid: "1_1" }).catch(
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(ToolError);
        expect((failure as Error).message).toBe(STALE_UID_MESSAGE);
        expect(fake.sent).toEqual([]);
    });

    it("reports a uid whose node is gone as stale", async () => {
        const { fake, elements } = setup();

        fake.failSend = () => new RpcError(ErrorCode.cdpError, "No node with given id found");
        elements.nextGeneration("tab1");

        const [uid] = elements.assign("tab1", [{ backendNodeId: 7 }]);
        const failure = await resolveElement(fake.asAccess(), elements, "tab1", { uid }).catch(
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(ToolError);
        expect((failure as Error).message).toBe(STALE_UID_MESSAGE);
    });

    it("passes non-CDP failures of the uid path through", async () => {
        const { fake, elements } = setup();

        fake.failSend = () => new RpcError(ErrorCode.cdpTimeout, "CDP request timed out.");
        elements.nextGeneration("tab1");

        const [uid] = elements.assign("tab1", [{ backendNodeId: 7 }]);
        const failure = await resolveElement(fake.asAccess(), elements, "tab1", { uid }).catch(
            (error: unknown) => error,
        );

        expect(failure).toMatchObject({ code: ErrorCode.cdpTimeout });
    });

    it("resolves a selector through getDocument, querySelector and resolveNode", async () => {
        const { fake, elements } = setup();
        const resolved = await resolveElement(fake.asAccess(), elements, "tab1", {
            selector: "#main",
        });

        expect(resolved).toEqual({ backendNodeId: 7, objectId: "obj-1" });
        expect(fake.sent.map((call) => call.method)).toEqual([
            "DOM.getDocument",
            "DOM.querySelector",
            "DOM.resolveNode",
            "DOM.describeNode",
        ]);
        expect(fake.sent[1]?.params).toEqual({ nodeId: 1, selector: "#main" });
    });

    it("reports no match and an invalid selector with the DOM message quoted", async () => {
        const { fake, elements } = setup();
        const missing = await resolveElement(fake.asAccess(), elements, "tab1", {
            selector: "#missing",
        }).catch((error: unknown) => error);

        expect((missing as Error).message).toContain("No element matches");
        expect((missing as Error).message).toContain("#missing");

        fake.failSend = undefined;

        fake.respond = (_targetId, method, params) => {
            if (method === "DOM.getDocument") return { root: { nodeId: 1 } };

            if (method === "DOM.querySelector") {
                throw new RpcError(ErrorCode.cdpError, "'??' is not a valid selector.");
            }

            throw new Error(`unexpected CDP call ${method} ${JSON.stringify(params)}`);
        };

        const invalid = await resolveElement(fake.asAccess(), elements, "tab1", {
            selector: "??",
        }).catch((error: unknown) => error);

        expect((invalid as Error).message).toContain("is invalid");
        expect((invalid as Error).message).toContain("'??' is not a valid selector.");
    });
});

describe("rectOfQuad", () => {
    it("reduces a quad to a rounded bounding rectangle", () => {
        expect(rectOfQuad([10.4, 20.6, 30.2, 20.1, 30.9, 40.4, 10.2, 40.8])).toEqual({
            x     : 10,
            y     : 20,
            width : 21,
            height: 21,
        });
    });
});

describe("boxOf", () => {
    it("reads the content quad of the box model", async () => {
        const fake = new FakeAccess();

        fake.respond = () => BOX;
        const box = await boxOf(fake.asAccess(), "tab1", { backendNodeId: 7 });

        expect(box).toEqual({ box: { x: 10, y: 20, width: 20, height: 20 }, visible: true });
        expect(fake.sent[0]).toMatchObject({
            method: "DOM.getBoxModel",
            params: { backendNodeId: 7 },
        });
    });

    it("reports a hidden element as invisible without a box", async () => {
        const fake = new FakeAccess();

        fake.failSend = () => new RpcError(ErrorCode.cdpError, "Could not compute box model.");
        const box = await boxOf(fake.asAccess(), "tab1", { nodeId: 3 });

        expect(box).toEqual({ box: null, visible: false });
    });

    it("reports a zero-size box as invisible", async () => {
        const fake = new FakeAccess();

        fake.respond = () => ({
            model: {
                content: [5, 5, 5, 5, 5, 5, 5, 5],
                padding: [5, 5, 5, 5, 5, 5, 5, 5],
                border : [5, 5, 5, 5, 5, 5, 5, 5],
                margin : [5, 5, 5, 5, 5, 5, 5, 5],
            },
        });
        const box = await boxOf(fake.asAccess(), "tab1", { objectId: "obj-9" });

        expect(box).toEqual({ box: { x: 5, y: 5, width: 0, height: 0 }, visible: false });
    });
});

describe("revealElement", () => {
    it("scrolls the element into view and returns its box", async () => {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) => (method === "DOM.getBoxModel" ? BOX : {});
        const box = await revealElement(fake.asAccess(), "tab1", { backendNodeId: 7 });

        expect(box.visible).toBe(true);
        expect(fake.sent.map((call) => call.method)).toEqual([
            "DOM.scrollIntoViewIfNeeded",
            "DOM.getBoxModel",
        ]);
    });

    it("reports an element that cannot be scrolled into view", async () => {
        const fake = new FakeAccess();

        fake.failSend = (_targetId, method) => {
            if (method === "DOM.scrollIntoViewIfNeeded") {
                return new RpcError(ErrorCode.cdpError, "Could not compute box model.");
            }

            throw new Error(`unexpected failure for ${method}`);
        };

        const failure = await revealElement(fake.asAccess(), "tab1", { nodeId: 3 }).catch(
            (error: unknown) => error,
        );

        expect((failure as Error).message).toContain("cannot be scrolled into view");
    });
});
