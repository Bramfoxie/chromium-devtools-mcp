import { describe, expect, it } from "vitest";
import "../src/tools/index.js";
import { runSteps } from "../src/tools/emulation/steps.js";
import { FakeAccess } from "./helpers/fake-access.js";

describe("emulation steps", () => {
    it("stops rollback when the session resets during an undo", async () => {
        const fake = new FakeAccess();
        const access = fake.asAccess();
        let release: () => void = () => undefined;
        let signalStarted: () => void = () => undefined;
        let calls = 0;
        let unrecorded = false;
        let undoFailed = false;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const started = new Promise<void>((resolve) => (signalStarted = resolve));

        access.assertCurrent = (generation) => {
            if (generation !== fake.generation) throw new Error("session reset");
        };

        fake.respond = () => {
            calls += 1;
            if (calls === 2) throw new Error("command failed");

            if (calls === 3) {
                signalStarted();

                return gate;
            }

            return {};
        };

        const command = (rate: number) => ({ method: "Emulation.setCPUThrottlingRate", params: { rate } });
        const pending = runSteps(access, new AbortController().signal, "tab1", [
            {
                commands: [command(4)], record  : () => undefined, undo    : [command(1)],
                unrecord: () => { unrecorded = true; },
            },
            {
                commands  : [command(5)], record    : () => undefined, undo      : [command(2)],
                undoFailed: () => { undoFailed = true; },
            },
        ]);

        await started;
        fake.bumpGeneration();
        release();
        await expect(pending).rejects.toThrow("command failed");
        expect(fake.sent).toHaveLength(3);
        expect(unrecorded).toBe(false);
        expect(undoFailed).toBe(false);
    });

    it("does not record or undo an old command after the session resets", async () => {
        const fake = new FakeAccess();
        const access = fake.asAccess();
        let release: () => void = () => undefined;
        let recorded = false;
        const gate = new Promise<void>((resolve) => (release = resolve));

        access.assertCurrent = (generation) => {
            if (generation !== fake.generation) throw new Error("session reset");
        };

        fake.respond = () => gate;
        const pending = runSteps(access, new AbortController().signal, "tab1", [{
            commands: [{ method: "Emulation.setCPUThrottlingRate", params: { rate: 4 } }],
            record  : () => { recorded = true; },
            undo    : [{ method: "Emulation.setCPUThrottlingRate", params: { rate: 1 } }],
        }]);

        fake.bumpGeneration();
        release();
        await expect(pending).rejects.toThrow("session reset");
        expect(recorded).toBe(false);
        expect(fake.sent).toHaveLength(1);
    });
});
