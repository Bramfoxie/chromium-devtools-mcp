import { describe, expect, it, vi } from "vitest";
import { ErrorCode, RpcError } from "../src/daemon/index.js";
import {
    boxOf,
    ElementRegistry,
    FrameState,
    elementTargetSchema,
    MAX_UIDS_PER_TAB,
    rectOfQuad,
    resolveElement,
    revealElement,
    splitPierceChain,
    STALE_UID_MESSAGE,
    ToolError,
    withElement,
} from "../src/tools/index.js";
import { managedConfig } from "./helpers/daemon-env.js";
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

        expect(uids.every((uid) => uid !== undefined)).toBe(true);
        expect(elements.lookup("tab1", `0_${MAX_UIDS_PER_TAB + 5}`)).toBeDefined();
        expect(elements.lookup("tab1", "0_1")).toBeUndefined();
        elements.reset();

        expect(elements.lookup("tab1", `0_${MAX_UIDS_PER_TAB + 5}`)).toBeUndefined();
        expect(elements.generation("tab1")).toBe(0);
    });

    it("keeps the uid of a repeated element instead of burning the budget", () => {
        const elements = new ElementRegistry();
        const [first] = elements.assign("tab1", [{ backendNodeId: 7 }]);
        const [second] = elements.assign("tab1", [{ backendNodeId: 7 }]);

        expect(first).toBeDefined();
        expect(second).toBe(first);
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

describe("elementTargetSchema piercing fields", () => {
    it("accepts pierce and frame with a selector", () => {
        expect(
            elementTargetSchema.safeParse({ selector: "my-app", pierce: true }).success,
        ).toBe(true);
        expect(
            elementTargetSchema.safeParse({ selector: "#inner", frame: "#frame" }).success,
        ).toBe(true);
    });

    it("rejects pierce and frame with a uid", () => {
        const pierced = elementTargetSchema.safeParse({ uid: "1_1", pierce: true });
        const framed = elementTargetSchema.safeParse({ uid: "1_1", frame: "f" });

        expect(pierced.success).toBe(false);
        expect(framed.success).toBe(false);

        if (!pierced.success) {
            expect(pierced.error.issues[0]?.message).toContain("only combine with selector");
        }
    });

    it("rejects an overlong frame value", () => {
        expect(
            elementTargetSchema.safeParse({ selector: "a", frame: "x".repeat(1025) }).success,
        ).toBe(false);
        expect(
            elementTargetSchema.safeParse({ selector: "a", frame: "x".repeat(1024) }).success,
        ).toBe(true);
    });
});

describe("splitPierceChain", () => {
    it("returns undefined for a plain selector", () => {
        expect(splitPierceChain("#main .item")).toBeUndefined();
    });

    it("splits a chain around >>> and trims segments", () => {
        expect(splitPierceChain("my-app >>> #inner >>> button")).toEqual([
            "my-app",
            "#inner",
            "button",
        ]);
    });

    it("rejects an empty segment with a clear message", () => {
        expect(() => splitPierceChain("my-app >>>  >>> button")).toThrow("empty segment");
    });

    it("rejects a chain over the segment limit", () => {
        expect(() => splitPierceChain(Array(12).fill("a").join(" >>> "))).toThrow(
            "over the limit",
        );
    });
});

describe("ElementRegistry frame generations", () => {
    it("reports a uid stale when its frame navigated", () => {
        const elements = new ElementRegistry();

        elements.nextGeneration("tab1");

        const [uid] = elements.assign("tab1", [
            { backendNodeId: 1, frameId: "f1", frameGeneration: 0 },
            { backendNodeId: 2 },
        ]);

        expect(elements.lookup("tab1", uid ?? "", () => 0)?.backendNodeId).toBe(1);
        expect(elements.lookup("tab1", uid ?? "", () => 1)).toBeUndefined();
        expect(elements.lookup("tab1", "1_2", () => 1)?.backendNodeId).toBe(2);
    });

    it("drops only the uids of an invalidated frame", () => {
        const elements = new ElementRegistry();

        elements.nextGeneration("tab1");
        elements.assign("tab1", [
            { backendNodeId: 1, frameId: "f1" },
            { backendNodeId: 2, frameId: "f2" },
            { backendNodeId: 3 },
        ]);
        elements.invalidateFrame("tab1", "f1");

        expect(elements.lookup("tab1", "1_1")).toBeUndefined();
        expect(elements.lookup("tab1", "1_2")?.backendNodeId).toBe(2);
        expect(elements.lookup("tab1", "1_3")?.backendNodeId).toBe(3);
    });
});

describe("resolveElement piercing", () => {
    function piercingSetup() {
        const fake = new FakeAccess();
        const elements = new ElementRegistry();

        fake.respond = (_targetId, method, params) => {
            switch (method) {
                case "DOM.getDocument":
                    return { root: { nodeId: 1 } };

                case "DOM.querySelectorAll":
                    return { nodeIds: [10] };

                case "DOM.querySelector": {
                    const selector = params?.selector as string;

                    if (selector === "my-app") return { nodeId: 13 };
                    if (selector === "#inner") return { nodeId: 15 };
                    if (selector === "#frame") return { nodeId: 10 };

                    return { nodeId: selector === "#missing" ? 0 : 41 };
                }

                case "DOM.resolveNode":
                    return { object: { objectId: "obj-1" } };

                case "DOM.describeNode": {
                    const nodeId = params?.nodeId as number;

                    if (nodeId === 13) {
                        return {
                            node: {
                                nodeName     : "MY-APP",
                                backendNodeId: 5,
                                shadowRoots  : [{ nodeId: 14 }],
                            },
                        };
                    }

                    if (nodeId === 10) {
                        return {
                            node: {
                                nodeName       : "IFRAME",
                                backendNodeId  : 20,
                                frameId        : "frame1",
                                contentDocument: { nodeId: 11 },
                            },
                        };
                    }

                    return { node: { nodeId, backendNodeId: 7 } };
                }

                case "DOM.enable":
                    return {};
                case "DOM.performSearch":
                    return { searchId: "s1", resultCount: 1 };
                case "DOM.getSearchResults":
                    return { nodeIds: [15] };
                case "DOM.discardSearchResults":
                    return {};
                default:
                    throw new Error(`unexpected CDP call ${method}`);
            }
        };

        return { fake, elements };
    }

    it("resolves a >>> chain through shadow roots", async () => {
        const { fake, elements } = piercingSetup();
        const resolved = await resolveElement(fake.asAccess(), elements, "tab1", {
            selector: "my-app >>> #inner",
        });

        expect(resolved).toEqual({ backendNodeId: 7, objectId: "obj-1" });
        expect(fake.sent.map((call) => call.method)).toEqual([
            "DOM.getDocument",
            "DOM.querySelector",
            "DOM.describeNode",
            "DOM.querySelector",
            "DOM.resolveNode",
            "DOM.describeNode",
        ]);
        expect(fake.sent[3]?.params).toEqual({ nodeId: 14, selector: "#inner" });
    });

    it("reports a chain segment with no match or no shadow root", async () => {
        const { fake, elements } = piercingSetup();
        const missing = await resolveElement(fake.asAccess(), elements, "tab1", {
            selector: "my-app >>> #missing",
        }).catch((error: unknown) => error);

        expect((missing as Error).message).toContain("at segment");

        fake.respond = (_targetId, method, params) => {
            if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
            if (method === "DOM.querySelector") return { nodeId: 41 };

            if (method === "DOM.describeNode") {
                return { node: { nodeId: 41, backendNodeId: 7 } };
            }

            throw new Error(`unexpected CDP call ${method} ${JSON.stringify(params)}`);
        };

        const noRoot = await resolveElement(fake.asAccess(), elements, "tab1", {
            selector: "#main >>> button",
        }).catch((error: unknown) => error);

        expect((noRoot as Error).message).toContain("no shadow root");
    });

    it("resolves pierce through performSearch and discards the search", async () => {
        const { fake, elements } = piercingSetup();
        const resolved = await resolveElement(fake.asAccess(), elements, "tab1", {
            selector: "button",
            pierce  : true,
        });

        expect(resolved).toEqual({ backendNodeId: 7, objectId: "obj-1" });
        expect(fake.sent.map((call) => call.method)).toEqual([
            "DOM.getDocument",
            "DOM.enable",
            "DOM.getDocument",
            "DOM.performSearch",
            "DOM.getSearchResults",
            "DOM.discardSearchResults",
            "DOM.resolveNode",
            "DOM.describeNode",
        ]);
        expect(fake.sent[3]?.params).toMatchObject({ query: "button" });
    });

    it("reports no pierced match and rejects pierce with a chain", async () => {
        const { fake, elements } = piercingSetup();

        fake.respond = (_targetId, method) => {
            switch (method) {
                case "DOM.getDocument":
                    return { root: { nodeId: 1 } };
                case "DOM.enable":
                    return {};
                case "DOM.performSearch":
                    return { searchId: "s1", resultCount: 0 };
                case "DOM.discardSearchResults":
                    return {};
                default:
                    throw new Error(`unexpected CDP call ${method}`);
            }
        };

        const missing = await resolveElement(fake.asAccess(), elements, "tab1", {
            selector: "button",
            pierce  : true,
        }).catch((error: unknown) => error);

        expect((missing as Error).message).toContain("No element matches");

        const both = await resolveElement(fake.asAccess(), elements, "tab1", {
            selector: "a >>> b",
            pierce  : true,
        }).catch((error: unknown) => error);

        expect((both as Error).message).toContain("not both");
    });

    it("resolves a frame given as an iframe selector", async () => {
        const { fake, elements } = piercingSetup();
        const resolved = await resolveElement(fake.asAccess(), elements, "tab1", {
            selector: "#same-btn",
            frame   : "#frame",
        });

        expect(resolved).toEqual({ backendNodeId: 7, objectId: "obj-1", frameId: "frame1" });
        expect(fake.sent.map((call) => call.method)).toEqual([
            "DOM.getDocument",
            "DOM.querySelectorAll",
            "DOM.describeNode",
            "DOM.querySelector",
            "DOM.resolveNode",
            "DOM.describeNode",
        ]);
        expect(fake.sent[3]?.params).toEqual({ nodeId: 11, selector: "#same-btn" });
    });

    it("lists the candidates when a frame selector matches several iframes", async () => {
        const { fake, elements } = piercingSetup();
        const inner = fake.respond;

        fake.respond = (targetId, method, params) => {
            if (method === "DOM.querySelectorAll") return { nodeIds: [10, 12] };

            if (method === "DOM.describeNode" && params?.nodeId === 12) {
                return {
                    node: {
                        nodeName       : "IFRAME",
                        backendNodeId  : 22,
                        attributes     : ["name", "ads", "src", "https://c.example/"],
                        frameId        : "ads-frame",
                        contentDocument: { nodeId: 13, documentURL: "https://c.example/ad" },
                    },
                };
            }

            return inner?.(targetId, method, params);
        };

        const failure = await resolveElement(fake.asAccess(), elements, "tab1", {
            selector: "#same-btn",
            frame   : "iframe",
        }).catch((error: unknown) => error);
        const message = (failure as Error).message;

        expect(message).toContain("matches 2 iframes");
        expect(message).toContain("1: <iframe> id=\"\" name=\"ads\" url=\"https://c.example/ad\" frame=ads-frame");
        expect(message).toContain("frame id from dom_snapshot");
    });

    it("rejects a frame selector that matches no iframe", async () => {
        const { fake, elements } = piercingSetup();

        fake.respond = (_targetId, method, params) => {
            if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
            if (method === "DOM.querySelectorAll") return { nodeIds: [10] };

            if (method === "DOM.querySelector") {
                return { nodeId: params?.selector === "#frame" ? 10 : 41 };
            }

            if (method === "DOM.describeNode") {
                return { node: { nodeId: 10, backendNodeId: 20, nodeName: "DIV" } };
            }

            throw new Error(`unexpected CDP call ${method}`);
        };

        const failure = await resolveElement(fake.asAccess(), elements, "tab1", {
            selector: "#same-btn",
            frame   : "#frame",
        }).catch((error: unknown) => error);

        expect((failure as Error).message).toContain("not an iframe");
    });
});

describe("resolveElement frame ids", () => {
    function frameSetup() {
        const fake = new FakeAccess();
        const elements = new ElementRegistry();

        fake.frames = [
            { frameId: "main", url: "https://a.example/", name: "", isolated: false },
            {
                frameId      : "cross",
                parentFrameId: "main",
                url          : "https://b.example/",
                name         : "pay",
                isolated     : false,
            },
        ];

        fake.respond = (_targetId, method, params) => {
            switch (method) {
                case "DOM.getDocument": {
                    const pierce = (params as { pierce?: unknown })?.pierce;

                    if (pierce === true) {
                        return {
                            root: {
                                nodeId  : 1,
                                nodeName: "#document",
                                children: [
                                    {
                                        nodeId         : 10,
                                        nodeName       : "IFRAME",
                                        frameId        : "cross",
                                        contentDocument: { nodeId: 11, nodeName: "#document" },
                                    },
                                ],
                            },
                        };
                    }

                    return { root: { nodeId: 1 } };
                }

                case "DOM.querySelector":
                    return { nodeId: 41 };
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

    it("resolves a frame id through the frame state", async () => {
        const { fake, elements } = frameSetup();
        const { FrameState } = await import("../src/tools/index.js");
        const frames = new FrameState({ access: fake.asAccess() });

        await frames.ensure("tab1");

        const resolved = await resolveElement(fake.asAccess(), elements, "tab1", {
            selector: "#pay-btn",
            frame   : "cross",
        }, { frames });

        expect(resolved).toEqual({ backendNodeId: 7, objectId: "obj-1", frameId: "cross" });
        expect(fake.sent.map((call) => call.method)).toEqual([
            "DOM.getDocument",
            "DOM.getDocument",
            "DOM.querySelector",
            "DOM.resolveNode",
            "DOM.describeNode",
        ]);
        expect(fake.sent[2]?.params).toEqual({ nodeId: 11, selector: "#pay-btn" });
    });

    it("fails naming a known frame that has no document yet", async () => {
        const { fake, elements } = frameSetup();
        const inner = fake.respond;

        fake.respond = (targetId, method, params) => {
            if (method === "DOM.getDocument") {
                return { root: { nodeId: 1, nodeName: "#document", children: [] } };
            }

            return inner?.(targetId, method, params);
        };

        const { FrameState } = await import("../src/tools/index.js");
        const frames = new FrameState({ access: fake.asAccess() });

        await frames.ensure("tab1");

        const failure = await resolveElement(fake.asAccess(), elements, "tab1", {
            selector: "#pay-btn",
            frame   : "cross",
        }, { frames }).catch((error: unknown) => error);

        expect((failure as Error).message).toContain("has no document yet");
        expect((failure as Error).message).toContain("cross");
        expect(fake.sent.map((call) => call.method)).not.toContain("DOM.querySelector");
    });

    it("reports a stale uid when its frame navigated", async () => {
        const { fake, elements } = frameSetup();
        const { FrameState } = await import("../src/tools/index.js");
        const frames = new FrameState({ access: fake.asAccess() });

        frames.attach();
        await frames.ensure("tab1");
        elements.nextGeneration("tab1");

        const [uid] = elements.assign("tab1", [
            { backendNodeId: 7, frameId: "cross", frameGeneration: 0 },
        ]);

        fake.emit("cdp.event", {
            targetId: "tab1",
            event   : "Page.frameNavigated",
            params  : { frame: { id: "cross" } },
        });

        const failure = await resolveElement(fake.asAccess(), elements, "tab1", { uid }, { frames })
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ToolError);
        expect((failure as Error).message).toBe(STALE_UID_MESSAGE);
        expect(fake.sent).toEqual([]);
    });
});

describe("withElement with a pierced target under an allowlist", () => {
    const restricted = {
        ...managedConfig,
        safety: { ...managedConfig.safety, allowedDomains: ["a.example"] },
    };

    function pierced(documentUrl: unknown) {
        const fake = new FakeAccess();

        fake.respond = (_targetId, method) => {
            switch (method) {
                case "DOM.getDocument":
                    return { root: { nodeId: 1 } };
                case "DOM.enable":
                case "DOM.discardSearchResults":
                case "Runtime.releaseObject":
                    return {};
                case "DOM.performSearch":
                    return { searchId: "s1", resultCount: 1 };
                case "DOM.getSearchResults":
                    return { nodeIds: [15] };
                case "DOM.resolveNode":
                    return { object: { objectId: "obj-1" } };
                case "DOM.describeNode":
                    return { node: { nodeId: 15, backendNodeId: 7 } };
                case "Runtime.callFunctionOn":
                    if (documentUrl === undefined) throw new Error("detached");

                    return { result: { value: documentUrl } };
                default:
                    throw new Error(`unexpected CDP call ${method}`);
            }
        };

        const scope = {
            config  : restricted,
            access  : fake.asAccess(),
            elements: new ElementRegistry(),
            frames  : new FrameState({ access: fake.asAccess() }),
        };

        return { fake, scope };
    }

    const target = { selector: "button", pierce: true };

    it("refuses an element whose document is outside the list", async () => {
        const { fake, scope } = pierced("https://evil.example/frame");
        const use = vi.fn(async () => "ran");
        const failure = await withElement(scope, "tab1", target, use).catch((error: unknown) => error);

        expect((failure as Error).message).toContain("outside safety.allowedDomains");
        expect(use).not.toHaveBeenCalled();
        expect(fake.sent.at(-1)?.method).toBe("Runtime.releaseObject");
    });

    it("refuses when the document of the element cannot be read", async () => {
        const { scope } = pierced(undefined);
        const failure = await withElement(scope, "tab1", target, async () => "ran").catch(
            (error: unknown) => error,
        );

        expect((failure as Error).message).toContain("could not be checked");
    });

    it("runs the action for an element in an allowed document", async () => {
        const { scope } = pierced("https://a.example/page");

        await expect(withElement(scope, "tab1", target, async () => "ran")).resolves.toBe("ran");
    });
});
