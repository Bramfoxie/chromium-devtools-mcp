import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { eventListeners, newTab, runTool, ToolRuntime } from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";
import { managedConfig } from "./helpers/daemon-env.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
const extra = () => ({ signal: new AbortController().signal }) as Extra;

async function setup(reply: unknown) {
    const fake = new FakeAccess();

    fake.respond = (_tab, method) => {
        if (method === "DOM.resolveNode") return { object: { objectId: "object" } };
        if (method === "DOMDebugger.getEventListeners") return reply;

        return {};
    };

    const runtime = new ToolRuntime({ access: fake.asAccess(), config: managedConfig });

    await runTool(newTab, {}, extra(), runtime);
    runtime.elements.nextGeneration("tab1");
    const [uid] = runtime.elements.assign("tab1", [{ backendNodeId: 7 }]);

    fake.sent.length = 0;

    return { fake, runtime, uid };
}

describe("event_listeners", () => {
    it("returns only bounded listener metadata and releases the object", async () => {
        const { fake, runtime, uid } = await setup({ listeners: [
            { type: "click", useCapture: true, passive: false, once: true, scriptId: "secret", handler: { objectId: "h1" }, originalHandler: { objectId: "o1" } },
            { type: "x".repeat(300), useCapture: false, passive: true, once: false, handler: { objectId: "h2" } },
        ] });
        const result = await runTool(
            eventListeners, { target: { uid }, limit: 1 }, extra(), runtime,
        );

        expect(result.structuredContent).toEqual({ listeners: [{ type: "click", useCapture: true, passive: false, once: true }], total: 2, truncated: true });
        expect(fake.sent).toContainEqual(expect.objectContaining({ method: "Runtime.releaseObject", params: { objectId: "object" } }));

        const released = fake.sent
            .filter((call) => call.method === "Runtime.releaseObject")
            .map((call) => (call.params as { objectId: string }).objectId);

        expect(released.sort()).toEqual(["h1", "h2", "o1", "object"]);
    });

    it("releases the object when the response is invalid", async () => {
        const { fake, runtime, uid } = await setup({ listeners: [{ handler: { objectId: "h1" } }] });
        const result = await runTool(eventListeners, { target: { uid } }, extra(), runtime);

        expect(result.isError).toBe(true);
        expect(fake.sent).toContainEqual(expect.objectContaining({ method: "Runtime.releaseObject", params: { objectId: "h1" } }));
        expect(fake.sent).toContainEqual(expect.objectContaining({ method: "Runtime.releaseObject", params: { objectId: "object" } }));
    });
});
