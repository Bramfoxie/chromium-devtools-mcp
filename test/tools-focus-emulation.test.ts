import { describe, expect, it } from "vitest";
import { FocusEmulation } from "../src/tools/index.js";
import { FakeAccess } from "./helpers/fake-access.js";

describe("FocusEmulation", () => {
    it("enables focus emulation once per tab", async () => {
        const fake = new FakeAccess();
        const focus = new FocusEmulation();

        expect(focus.enabled("tab1")).toBe(false);
        await focus.ensure(fake.asAccess(), "tab1");
        await focus.ensure(fake.asAccess(), "tab1");
        await focus.ensure(fake.asAccess(), "tab2");

        expect(focus.enabled("tab1")).toBe(true);
        expect(focus.enabled("tab2")).toBe(true);
        expect(fake.sent.map((entry) => entry.method)).toEqual([
            "Emulation.setFocusEmulationEnabled",
            "Emulation.setFocusEmulationEnabled",
        ]);
        expect(fake.sent[0]).toMatchObject({
            targetId: "tab1",
            params  : { enabled: true },
        });
        expect(fake.sent[1]).toMatchObject({ targetId: "tab2" });
    });

    it("retries after a failure and never marks the tab before success", async () => {
        const fake = new FakeAccess();
        const focus = new FocusEmulation();
        let calls = 0;

        fake.respond = () => {
            calls += 1;

            if (calls === 1) throw new Error("socket closed");

            return {};
        };

        await expect(focus.ensure(fake.asAccess(), "tab1")).rejects.toThrow("socket closed");
        expect(focus.enabled("tab1")).toBe(false);
        await focus.ensure(fake.asAccess(), "tab1");
        expect(focus.enabled("tab1")).toBe(true);
        expect(fake.sent).toHaveLength(2);
    });

    it("forgets one tab or all tabs on reset", async () => {
        const fake = new FakeAccess();
        const focus = new FocusEmulation();

        await focus.ensure(fake.asAccess(), "tab1");
        await focus.ensure(fake.asAccess(), "tab2");
        focus.forget("tab1");
        expect(focus.enabled("tab1")).toBe(false);
        expect(focus.enabled("tab2")).toBe(true);
        focus.reset();
        expect(focus.enabled("tab2")).toBe(false);
    });
});
