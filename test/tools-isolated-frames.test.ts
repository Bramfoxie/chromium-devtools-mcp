import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ElementRegistry, FrameState, resolveElement } from "../src/tools/index.js";
import { bindAccess, isolatedDocumentNode } from "../src/tools/frame-scope.js";
import { withWheelProbe } from "../src/tools/wheel-probe.js";
import { FakeAccess } from "./helpers/fake-access.js";

function crossFake(): FakeAccess {
    const fake = new FakeAccess();

    fake.frames = [
        { frameId: "main", url: "https://a.example/", name: "", isolated: false },
        { frameId: "cross", parentFrameId: "main", url: "https://b.example/", name: "pay", isolated: true },
        { frameId: "inside", parentFrameId: "cross", url: "https://b.example/in", name: "in", isolated: true },
    ];

    fake.respond = (_targetId, method, params) => {
        const frameId = fake.sent.at(-1)?.frameId;

        switch (method) {
            case "Page.getFrameTree":
                return { frameTree: { frame: { id: frameId === "cross" ? "cross" : "main" } } };
            case "DOM.getDocument":
                if (frameId === undefined) {
                    return {
                        root: {
                            nodeId  : 1,
                            nodeName: "#document",
                            children: [{ nodeId: 10, nodeName: "IFRAME", frameId: "cross" }],
                        },
                    };
                }

                return {
                    root: {
                        nodeId  : 100,
                        nodeName: "#document",
                        children: [
                            {
                                nodeId         : 110,
                                nodeName       : "IFRAME",
                                frameId        : "inside",
                                contentDocument: { nodeId: 111, nodeName: "#document" },
                            },
                        ],
                    },
                };
            case "DOM.querySelector":
                return (params as { selector?: unknown })?.selector === "#frame" ? { nodeId: 10 } : { nodeId: 141 };
            case "DOM.querySelectorAll":
                return { nodeIds: [10] };
            case "DOM.describeNode":
                return (params as { nodeId?: unknown })?.nodeId === 10
                    ? { node: { nodeName: "IFRAME", frameId: "cross", backendNodeId: 20 } }
                    : { node: { nodeId: 141, backendNodeId: 7 } };
            case "DOM.resolveNode":
                return { object: { objectId: "obj-cross" } };
            default:
                throw new Error(`unexpected CDP call ${method}`);
        }
    };

    return fake;
}

describe("bindAccess", () => {
    it("sends commands to the bound frame unless another one is given", async () => {
        const fake = crossFake();
        const bound = bindAccess(fake.asAccess(), "cross");

        await bound.send({
            targetId: "tab1",
            method  : "Page.getFrameTree",
            params  : {},
        });
        await bound.send({
            targetId: "tab1",
            method  : "Page.getFrameTree",
            params  : {},
            frameId : "other",
        });

        expect(fake.sent.map((call) => call.frameId)).toEqual(["cross", "other"]);
    });
});

describe("isolatedDocumentNode", () => {
    it("returns the document of the session root frame", async () => {
        const fake = crossFake();
        const bound = bindAccess(fake.asAccess(), "cross");

        expect(await isolatedDocumentNode(bound, "tab1", "cross")).toBe(100);
    });

    it("returns the content document of a frame inside the session", async () => {
        const fake = crossFake();
        const bound = bindAccess(fake.asAccess(), "cross");

        expect(await isolatedDocumentNode(bound, "tab1", "inside")).toBe(111);
    });
});

describe("elements in a cross site frame", () => {
    async function resolve(frame: string) {
        const fake = crossFake();
        const frames = new FrameState({ access: fake.asAccess() });

        await frames.ensure("tab1");

        const resolved = await resolveElement(
            fake.asAccess(),
            new ElementRegistry(),
            "tab1",
            { selector: "#pay-btn", frame },
            { frames },
        );

        return { fake, resolved };
    }

    it("resolves an element through the session that owns the frame", async () => {
        const { fake, resolved } = await resolve("cross");

        expect(resolved).toEqual({
            backendNodeId: 7,
            objectId     : "obj-cross",
            frameId      : "cross",
            isolated     : true,
        });
        const owned = fake.sent.filter((call) => call.frameId === "cross").map((call) => call.method);

        expect(owned).toContain("DOM.querySelector");
        expect(owned).toContain("DOM.resolveNode");
        expect(fake.sent.find((call) => call.method === "DOM.querySelector")?.params)
            .toEqual({ nodeId: 100, selector: "#pay-btn" });
    });

    it("resolves the frame named by an iframe selector the main document cannot open", async () => {
        const { resolved } = await resolve("#frame");

        expect(resolved).toMatchObject({ frameId: "cross", isolated: true });
    });
});

describe("wheel probe routing", () => {
    it("routes nested frame hit tests and probe calls to their owners", async () => {
        const fake = crossFake();
        const frames = new FrameState({ access: fake.asAccess() });

        fake.respond = (_tab, method) => {
            const frame = fake.sent.at(-1)?.frameId;

            if (method === "DOM.getNodeForLocation") return { frameId: frame ?? "main", backendNodeId: 1 };
            if (method === "DOM.describeNode") return { node: frame === undefined ? { frameId: "cross" } : frame === "cross" ? { frameId: "inside" } : {} };
            if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 100, 0, 100, 100, 0, 100], border: [0, 0, 100, 0, 100, 100, 0, 100], width: 100, height: 100 } };
            if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
            if (method === "Runtime.evaluate") return { result: { value: true } };

            throw new Error(`unexpected CDP call ${method}`);
        };

        expect(await withWheelProbe(fake.asAccess(), frames, "tab1", { x: 50, y: 50 }, (read) => read())).toBe(true);
        expect(fake.sent.filter((entry) => entry.method === "DOM.getNodeForLocation").map((entry) => entry.frameId)).toEqual([undefined, "cross", "inside"]);
        expect(fake.sent.filter((entry) => entry.method === "Runtime.evaluate" || entry.method === "Page.createIsolatedWorld").map((entry) => entry.frameId)).toEqual(["inside", "inside", "inside", "inside"]);
    });
});

describe("wheel probe isolated worlds", () => {
    function setup() {
        const fake = crossFake();
        const frames = new FrameState({ access: fake.asAccess() });

        type Handler = (event: { isTrusted: boolean }) => void;
        const listeners = new Map<string, Set<Handler>>();
        const worlds = new Map<number, ReturnType<typeof createContext>>();
        let next = 0;
        let failRemove = false;

        fake.respond = (_tab, method, params) => {
            const frame = fake.sent.at(-1)?.frameId;

            if (method === "DOM.getNodeForLocation") return { frameId: frame ?? "main", backendNodeId: 1 };
            if (method === "DOM.describeNode") return { node: frame === undefined ? { frameId: "cross" } : frame === "cross" ? { frameId: "inside" } : {} };
            if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 100, 0, 100, 100, 0, 100], border: [0, 0, 100, 0, 100, 100, 0, 100], width: 100, height: 100 } };

            if (method === "Page.createIsolatedWorld") {
                const id = ++next;
                const documentId = String(params?.frameId);
                const handlers = listeners.get(documentId) ?? new Set<Handler>();

                listeners.set(documentId, handlers);
                worlds.set(id, createContext({ document: {
                    addEventListener   : (_type: string, handler: Handler) => handlers.add(handler),
                    removeEventListener: (_type: string, handler: Handler) =>
                        handlers.delete(handler),
                } }));

                return { executionContextId: id };
            }

            if (method === "Runtime.evaluate") {
                const expression = String(params?.expression);
                const world = worlds.get(Number(params?.contextId));

                if (failRemove && expression.includes("cdmWheelProbeRemove")) throw new Error("cleanup failed");
                if (!world) throw new Error("unknown world");

                return { result: { value: runInContext(expression, world) as boolean } };
            }

            throw new Error(`unexpected CDP call ${method}`);
        };

        return {
            probe: <T>(run: (read: () => Promise<boolean>) => Promise<T>) =>
                withWheelProbe(fake.asAccess(), frames, "tab1", { x: 50, y: 50 }, run),
            emit: (documentId: string, isTrusted: boolean) =>
                listeners.get(documentId)?.forEach((handler) => handler({ isTrusted })),
            count: () =>
                [...listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0),
            failCleanup: () => { failRemove = true; },
        };
    }

    it("observes only trusted events in the selected document", async () => {
        const env = setup();

        await env.probe(async (read) => {
            expect(await read()).toBe(false);
            env.emit("main", true);
            env.emit("inside", false);
            expect(await read()).toBe(false);
            env.emit("inside", true);
            expect(await read()).toBe(true);
        });
        expect(env.count()).toBe(0);
    });

    it("observes a trusted event delivered to the nested document", async () => {
        const env = setup();

        const observed = await env.probe(async (read) => {
            env.emit("inside", true);

            return read();
        });

        expect(observed).toBe(true);
        expect(env.count()).toBe(0);
    });

    it("does not observe a trusted event delivered to another frame", async () => {
        const env = setup();

        const observed = await env.probe(async (read) => {
            env.emit("cross", true);

            return read();
        });

        expect(observed).toBe(false);
        expect(env.count()).toBe(0);
    });

    it("keeps concurrent probes independent and cleans each listener", async () => {
        const env = setup();

        await env.probe(async (first) => {
            env.emit("inside", true);
            await env.probe(async (second) => {
                expect(env.count()).toBe(2);
                expect(await first()).toBe(true);
                expect(await second()).toBe(false);
            });
            expect(env.count()).toBe(1);
            expect(await first()).toBe(true);
        });
        expect(env.count()).toBe(0);
    });

    it("cleans up on failure and preserves errors when cleanup fails", async () => {
        const env = setup();

        await expect(env.probe(async () => { throw new Error("run failed"); })).rejects.toThrow("run failed");
        expect(env.count()).toBe(0);
        env.failCleanup();
        await expect(env.probe(async () => { throw new Error("run failed"); })).rejects.toThrow("run failed");
        await expect(env.probe(async () => "ok")).resolves.toBe("ok");
    });
});

describe("wheel probe failure contracts", () => {
    it.each(["world", "install", "read"])("treats %s failures as unobserved and cleans up the world", async (failure) => {
        const fake = crossFake();
        const frames = new FrameState({ access: fake.asAccess() });

        fake.respond = (_tab, method, params) => {
            if (method === "DOM.getNodeForLocation") return { frameId: "main" };

            if (method === "Page.createIsolatedWorld") {
                if (failure === "world") throw new Error("target closed");

                return { executionContextId: 42 };
            }

            if (method === "Runtime.evaluate") {
                const expression = String(params?.expression);

                if (expression.includes(`cdmWheelProbe${failure === "install" ? "Install" : "Read"}`) && failure !== "world") throw new Error("execution context destroyed");

                return { result: { value: true } };
            }

            throw new Error(`unexpected CDP call ${method}`);
        };

        expect(await withWheelProbe(fake.asAccess(), frames, "tab1", { x: 1, y: 2 }, (read) => read())).toBe(false);
        const cleanup = fake.sent.filter((call) => String(call.params?.expression).includes("cdmWheelProbeRemove"));

        expect(cleanup).toHaveLength(failure === "world" ? 0 : 1);
        if (cleanup.length) expect(cleanup[0]?.params?.contextId).toBe(42);
    });

    it("transforms and floors coordinates at each nested frame", async () => {
        const fake = crossFake();
        const frames = new FrameState({ access: fake.asAccess() });

        fake.respond = (_tab, method) => {
            const frame = fake.sent.at(-1)?.frameId;

            if (method === "DOM.getNodeForLocation") return { frameId: frame ?? "main", backendNodeId: 1 };
            if (method === "DOM.describeNode") return { node: frame === undefined ? { frameId: "cross" } : frame === "cross" ? { frameId: "inside" } : {} };
            if (method === "DOM.getBoxModel") return { model: { content: [10, 20, 210, 20, 210, 220, 10, 220], border: [10, 20, 210, 20, 210, 220, 10, 220], width: 100, height: 100 } };
            if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
            if (method === "Runtime.evaluate") return { result: { value: true } };

            throw new Error(`unexpected CDP call ${method}`);
        };

        expect(await withWheelProbe(fake.asAccess(), frames, "tab1", { x: 113.5, y: 135.5 }, (read) => read())).toBe(true);
        expect(fake.sent.filter((call) => call.method === "DOM.getNodeForLocation").map((call) => call.params)).toEqual([
            { x: 113, y: 135 }, { x: 51, y: 57 }, { x: 20, y: 18 },
        ]);
    });

    it("stops a frame cycle and leaves observation unconfirmed", async () => {
        const fake = crossFake();
        const frames = new FrameState({ access: fake.asAccess() });

        fake.respond = (_tab, method) => {
            const frame = fake.sent.at(-1)?.frameId;

            if (method === "DOM.getNodeForLocation") return { frameId: frame ?? "main", backendNodeId: 1 };
            if (method === "DOM.describeNode") return { node: { frameId: frame === "cross" ? "inside" : "cross" } };
            if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 100, 0, 100, 100, 0, 100], border: [0, 0, 100, 0, 100, 100, 0, 100], width: 100, height: 100 } };

            throw new Error(`unexpected CDP call ${method}`);
        };

        expect(await withWheelProbe(fake.asAccess(), frames, "tab1", { x: 5, y: 5 }, (read) => read())).toBe(false);
        expect(fake.sent.filter((call) => call.method === "DOM.getNodeForLocation")).toHaveLength(3);
        expect(fake.sent.some((call) => call.method === "Page.createIsolatedWorld")).toBe(false);
    });
});
