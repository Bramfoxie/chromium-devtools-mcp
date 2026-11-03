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

describe("safetyFrameOf", () => {
    it("reports the url and origin of a frame given by id", async () => {
        const access = framedAccess();
        const frames = new FrameState({ access: access.asAccess() });
        const elements = new ElementRegistry();

        await expect(
            tools.safetyFrameOf({ target: { selector: "#a", frame: "pay" } }, "tab1", elements, frames),
        ).resolves.toEqual({
            frameId: "pay",
            url    : "https://pay.example:8443/checkout?x=1",
            origin : "https://pay.example:8443",
        });
    });

    it("finds the frame of a uid and omits the origin of about:blank", async () => {
        const access = framedAccess();
        const frames = new FrameState({ access: access.asAccess() });
        const elements = new ElementRegistry();
        const [uid] = elements.assign("tab1", [{ backendNodeId: 5, frameId: "blank" }]);

        await expect(
            tools.safetyFrameOf({ target: { uid } }, "tab1", elements, frames),
        ).resolves.toEqual({ frameId: "blank", url: "about:blank" });
    });

    it("returns nothing without a frame reference or for an unknown frame", async () => {
        const access = framedAccess();
        const frames = new FrameState({ access: access.asAccess() });
        const elements = new ElementRegistry();

        await expect(
            tools.safetyFrameOf({ target: { selector: "#a" } }, "tab1", elements, frames),
        ).resolves.toBeUndefined();
        await expect(
            tools.safetyFrameOf({ frame: "nope" }, "tab1", elements, frames),
        ).resolves.toBeUndefined();
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

        expect(seen[0]).toMatchObject({
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
});
