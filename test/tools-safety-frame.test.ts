import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { SafetyRequest } from "../src/tools/index.js";

const seen: SafetyRequest[] = [];

vi.mock("../src/tools/safety.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../src/tools/safety.js")>();

    return {
        ...original,
        checkSafety: (request: SafetyRequest) => {
            seen.push(request);

            return original.checkSafety(request);
        },
    };
});

const tools = await import("../src/tools/index.js");
const { ElementRegistry, FrameState } = tools;
const { FakeAccess } = await import("./helpers/fake-access.js");
const { managedConfig } = await import("./helpers/daemon-env.js");

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const extra = () => ({ signal: new AbortController().signal }) as Extra;

function framedAccess(): InstanceType<typeof FakeAccess> {
    return new FakeAccess({
        tabs  : [{ targetId: "tab1", url: "https://a.example/", title: "a", owned: true, created: true }],
        frames: [
            { frameId: "main", url: "https://a.example/", name: "", isolated: false },
            {
                frameId      : "pay",
                parentFrameId: "main",
                url          : "https://pay.example:8443/checkout?x=1",
                name         : "pay",
                isolated     : true,
            },
            { frameId: "blank", parentFrameId: "main", url: "about:blank", name: "", isolated: false },
        ],
    });
}

describe("safetyFramesOf", () => {
    it("reports the url and origin of a frame given by id", async () => {
        const access = framedAccess();
        const frames = new FrameState({ access: access.asAccess() });
        const elements = new ElementRegistry();

        await expect(
            tools.safetyFramesOf({ target: { selector: "#a", frame: "pay" } }, "tab1", elements, frames),
        ).resolves.toEqual([
            {
                frameId: "pay",
                url    : "https://pay.example:8443/checkout?x=1",
                origin : "https://pay.example:8443",
            },
        ]);
    });

    it("judges an about:blank frame by the nearest ancestor with an address of its own", async () => {
        const access = framedAccess();
        const frames = new FrameState({ access: access.asAccess() });
        const elements = new ElementRegistry();
        const [uid] = elements.assign("tab1", [{ backendNodeId: 5, frameId: "blank" }]);

        await expect(
            tools.safetyFramesOf({ target: { uid } }, "tab1", elements, frames),
        ).resolves.toEqual([
            { frameId: "blank", url: "https://a.example/", origin: "https://a.example" },
        ]);
    });

    it("returns nothing without a frame reference or for an unknown frame", async () => {
        const access = framedAccess();
        const frames = new FrameState({ access: access.asAccess() });
        const elements = new ElementRegistry();

        await expect(
            tools.safetyFramesOf({ target: { selector: "#a" } }, "tab1", elements, frames),
        ).resolves.toEqual([]);
    });

    it("leaves a frame that the tab does not list to the check of the resolved element", async () => {
        const frames = new FrameState({ access: framedAccess().asAccess() });

        await expect(
            tools.safetyFramesOf({ frame: "iframe[name=pay]" }, "tab1", new ElementRegistry(), frames),
        ).resolves.toEqual([]);
    });

    it("walks up from nested frames that inherit their origin", async () => {
        const access = new FakeAccess({
            tabs  : [{ targetId: "tab1", url: "https://a.example/", title: "a", owned: true, created: true }],
            frames: [
                { frameId: "main", url: "https://a.example/", name: "", isolated: false },
                { frameId: "wrap", parentFrameId: "main", url: "https://b.example/wrap", name: "", isolated: false },
                { frameId: "doc", parentFrameId: "wrap", url: "about:srcdoc", name: "", isolated: false },
                { frameId: "deep", parentFrameId: "doc", url: "about:blank", name: "", isolated: false },
            ],
        });
        const frames = new FrameState({ access: access.asAccess() });
        const found = await tools.safetyFramesOf({ frame: "deep" }, "tab1", new ElementRegistry(), frames);

        expect(found).toEqual([
            { frameId: "deep", url: "https://b.example/wrap", origin: "https://b.example" },
        ]);
    });

    it("gives up on frames that inherit in a loop", async () => {
        const access = new FakeAccess({
            tabs  : [{ targetId: "tab1", url: "https://a.example/", title: "a", owned: true, created: true }],
            frames: [
                { frameId: "x", parentFrameId: "y", url: "about:blank", name: "", isolated: false },
                { frameId: "y", parentFrameId: "x", url: "about:blank", name: "", isolated: false },
            ],
        });
        const frames = new FrameState({ access: access.asAccess() });

        await expect(
            tools.safetyFramesOf({ frame: "x" }, "tab1", new ElementRegistry(), frames),
        ).rejects.toThrow("could not be placed");
    });

    it("collects the frames of every target of a call once", async () => {
        const frames = new FrameState({ access: framedAccess().asAccess() });
        const elements = new ElementRegistry();
        const [uid] = elements.assign("tab1", [{ backendNodeId: 5, frameId: "blank" }]);
        const collected = await tools.safetyFramesOf(
            {
                root  : { selector: "#r", frame: "pay" },
                from  : { uid },
                to    : { selector: "#t", frame: "pay" },
                fields: [
                    { target: { selector: "#a", frame: "pay" }, value: "x" },
                    { target: { selector: "#b" }, value: "y" },
                    "not a field",
                ],
            },
            "tab1",
            elements,
            frames,
        );

        expect(collected.map((frame) => frame.frameId).sort()).toEqual(["blank", "pay"]);
    });
});

describe("runTool safety request", () => {
    it("passes the frame of a mutating call to the safety check", async () => {
        const access = framedAccess();
        const runtime = new tools.ToolRuntime({ access: access.asAccess(), config: managedConfig });

        seen.length = 0;

        access.respond = () => {
            throw new Error("stop after the gate");
        };

        await tools.runTool(
            tools.inputClick,
            { tab: "tab1", target: { selector: "#pay", frame: "pay" } },
            extra(),
            runtime,
        );

        expect(seen.find((request) => request.frame !== undefined)).toMatchObject({
            tool : "input_click",
            frame: { frameId: "pay", origin: "https://pay.example:8443" },
        });
    });

    it("leaves the frame out when the call names none", async () => {
        const access = framedAccess();
        const runtime = new tools.ToolRuntime({ access: access.asAccess(), config: managedConfig });

        seen.length = 0;

        access.respond = () => {
            throw new Error("stop after the gate");
        };

        await tools.runTool(
            tools.inputClick,
            { tab: "tab1", target: { selector: "#pay" } },
            extra(),
            runtime,
        );

        expect(seen[0]?.frame).toBeUndefined();
    });

    it("refuses when any of several targets is in a frame outside the allowlist", async () => {
        const { defineTool } = tools;
        const { z } = await import("zod");
        const twoTargets = defineTool({
            name       : "two_targets",
            description: "Test tool with a source and a destination.",
            access     : "mutate",
            input      : z.strictObject({
                from: z.strictObject({ selector: z.string(), frame: z.string().optional() }),
                to  : z.strictObject({ selector: z.string(), frame: z.string().optional() }),
            }),
            output : z.strictObject({}),
            handler: async () => ({}),
        });
        const access = framedAccess();
        const config = {
            ...managedConfig,
            safety: { ...managedConfig.safety, allowedDomains: ["a.example"] },
        };
        const runtime = new tools.ToolRuntime({ access: access.asAccess(), config });

        runtime.tabs.select("tab1");

        const allowed = await tools.runTool(
            twoTargets,
            { from: { selector: "#a" }, to: { selector: "#b", frame: "blank" } },
            extra(),
            runtime,
        );

        expect(allowed.isError).not.toBe(true);

        const refused = await tools.runTool(
            twoTargets,
            { from: { selector: "#a" }, to: { selector: "#b", frame: "pay" } },
            extra(),
            runtime,
        );

        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused.content)).toContain("pay.example");
    });
});

describe("assertElementOriginAllowed", () => {
    const restricted = {
        ...managedConfig,
        safety: { ...managedConfig.safety, allowedDomains: ["a.example"] },
    };
    const element = { objectId: "o1", backendNodeId: 1, frameId: "f1" };

    async function check(reply: unknown, config = restricted) {
        const access = new FakeAccess();

        access.respond = () => {
            if (reply instanceof Error) throw reply;

            return { result: { value: reply } };
        };

        return tools.assertElementOriginAllowed({ config, access: access.asAccess() }, "tab1", element);
    }

    it("allows an element whose document has an allowed origin", async () => {
        await expect(check("https://a.example")).resolves.toBeUndefined();
    });

    it("refuses an element in a frame whose inherited origin is not allowed", async () => {
        await expect(check("https://b.example")).rejects.toThrow("b.example");
    });

    it("refuses a frame with no origin of its own and one it cannot read", async () => {
        await expect(check("null")).rejects.toThrow("no origin of its own");
        await expect(check(null)).rejects.toThrow("could not be checked");
        await expect(check(new Error("gone"))).rejects.toThrow("could not be checked");
    });

    it("checks nothing without an allowlist", async () => {
        await expect(check("https://b.example", managedConfig)).resolves.toBeUndefined();
    });
});
