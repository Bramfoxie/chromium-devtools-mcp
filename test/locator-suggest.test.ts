import { describe, expect, it } from "vitest";
import type { A11yEntry } from "../src/tools/a11y-tree.js";
import { pickLocator } from "../src/tools/index.js";

function entry(id: number, role: string, name: string): A11yEntry {
    return {
        backendNodeId: id,
        role,
        name,
        description  : "",
        value        : undefined,
        states       : {},
        level        : undefined,
        depth        : 0,
        interactive  : true,
        unnamed      : name === "",
    };
}

describe("pickLocator", () => {
    it("gives the role and the name when that is enough", () => {
        const entries = [entry(1, "button", "Save"), entry(2, "link", "Home")];

        expect(pickLocator(entries, 1)).toEqual({ role: "button", name: "Save" });
    });

    it("asks for the whole name when the name is part of another name of the same role", () => {
        const entries = [entry(1, "button", "Save"), entry(2, "button", "Save draft")];

        expect(pickLocator(entries, 1)).toEqual({ role: "button", name: "Save", exact: true });
        expect(pickLocator(entries, 2)).toEqual({ role: "button", name: "Save draft" });
    });

    it("adds the position among elements that have the very same role and name", () => {
        const entries = [
            entry(1, "button", "Delete"),
            entry(2, "link", "Delete"),
            entry(3, "button", "delete "),
            entry(4, "button", "Delete"),
        ];

        expect(pickLocator(entries, 3)).toEqual({ role: "button", name: "delete ", exact: true, nth: 1 });
        expect(pickLocator(entries, 1)).toEqual({ role: "button", name: "Delete", exact: true, nth: 0 });
        expect(pickLocator(entries, 4)).toMatchObject({ nth: 2 });
    });

    it("does not give a locator for a node without a name, plain text or an unknown node", () => {
        const entries = [entry(1, "button", ""), entry(2, "text", "Hello")];

        expect(pickLocator(entries, 1)).toBeUndefined();
        expect(pickLocator(entries, 2)).toBeUndefined();
        expect(pickLocator(entries, 99)).toBeUndefined();
    });
});
