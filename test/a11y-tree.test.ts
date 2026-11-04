import { describe, expect, it } from "vitest";
import { a11yEntries, summarizeA11y } from "../src/tools/index.js";
import type { AxNode } from "../src/tools/ax-format.js";

function node(id: string, patch: Partial<AxNode>, childIds: string[] = []): AxNode {
    return {
        nodeId       : id,
        ignored      : false,
        role         : "generic",
        name         : "",
        description  : "",
        value        : undefined,
        hidden       : false,
        properties   : {},
        childIds,
        backendNodeId: Number(id),
        ...patch,
    };
}

const defaults = { interactiveOnly: false, includeHidden: false, startBackendNode: undefined };

function tree(): AxNode[] {
    return [
        node("1", { role: "rootwebarea", name: "Page" }, ["2", "3", "4"]),
        node("2", { role: "banner" }, ["5"]),
        node("3", { role: "main" }, ["6", "7", "8", "9"]),
        node("4", { role: "generic" }, []),
        node("5", { role: "link", name: "Home", properties: {} }, ["10"]),
        node("6", { role: "heading", name: "Checkout", properties: { level: 1 } }),
        node("7", { role: "textbox", name: "Email", value: "a@b.test", properties: { required: true } }),
        node("8", { role: "button", name: "", properties: { disabled: true } }),
        node("9", { role: "checkbox", name: "Agree", properties: { checked: "mixed" } }),
        node("10", { role: "statictext", name: "Home" }),
    ];
}

describe("a11yEntries", () => {
    it("lists the meaningful nodes in document order with their depth", () => {
        const entries = a11yEntries(tree(), defaults);

        expect(entries.map((entry) => [entry.role, entry.name, entry.depth])).toEqual([
            ["banner", "", 0],
            ["link", "Home", 1],
            ["main", "", 0],
            ["heading", "Checkout", 1],
            ["textbox", "Email", 1],
            ["button", "", 1],
            ["checkbox", "Agree", 1],
        ]);
    });

    it("drops the text of a node that only repeats its name, and structure with no name", () => {
        const roles = a11yEntries(tree(), defaults).map((entry) => entry.role);

        expect(roles).not.toContain("text");
        expect(roles).not.toContain("generic");
        expect(roles).not.toContain("rootwebarea");
    });

    it("keeps text that is not an echo of its parent", () => {
        const nodes = [
            node("1", { role: "rootwebarea" }, ["2"]),
            node("2", { role: "paragraph", name: "" }, ["3"]),
            node("3", { role: "statictext", name: "Free text" }),
        ];

        expect(a11yEntries(nodes, defaults).map((entry) => [entry.role, entry.name])).toEqual([
            ["text", "Free text"],
        ]);
    });

    it("reports states, the heading level, values and a missing name on a control", () => {
        const entries = a11yEntries(tree(), defaults);
        const byRole = (role: string) => entries.find((entry) => entry.role === role);

        expect(byRole("heading")?.level).toBe(1);
        expect(byRole("textbox")).toMatchObject({ value: "a@b.test", states: { required: true } });
        expect(byRole("button")).toMatchObject({ unnamed: true, states: { disabled: true } });
        expect(byRole("checkbox")?.states.checked).toBe("mixed");
        expect(byRole("link")?.unnamed).toBe(false);
    });

    it("turns the strings true and false of a state into booleans and keeps mixed", () => {
        const nodes = [
            node("1", { role: "checkbox", name: "A", properties: { checked: "true", required: "false" } }),
            node("2", { role: "checkbox", name: "B", properties: { checked: "mixed" } }),
        ];
        const entries = a11yEntries(nodes, { ...defaults, startBackendNode: undefined });

        expect(entries[0]?.states).toEqual({ checked: true, required: false });
        expect(entries[1]?.states).toEqual({ checked: "mixed" });
    });

    it("lists only interactive nodes or only the given roles", () => {
        const interactive = a11yEntries(tree(), { ...defaults, interactiveOnly: true });
        const headings = a11yEntries(tree(), { ...defaults, roles: ["Heading"] });

        expect(interactive.map((entry) => entry.role)).toEqual(["link", "textbox", "button", "checkbox"]);
        expect(headings.map((entry) => entry.name)).toEqual(["Checkout"]);
    });

    it("hides hidden nodes with their children unless asked", () => {
        const nodes = [
            node("1", { role: "rootwebarea" }, ["2"]),
            node("2", { role: "button", name: "Hidden", hidden: true }, ["3"]),
            node("3", { role: "link", name: "Inside" }),
        ];

        expect(a11yEntries(nodes, defaults)).toEqual([]);
        expect(a11yEntries(nodes, { ...defaults, includeHidden: true })).toHaveLength(2);
    });

    it("walks through ignored nodes to their children and never lists them", () => {
        const nodes = [
            node("1", { role: "rootwebarea" }, ["2"]),
            node("2", { role: "button", name: "Ignored", ignored: true }, ["3"]),
            node("3", { role: "link", name: "Kept" }),
        ];

        expect(a11yEntries(nodes, defaults).map((entry) => entry.name)).toEqual(["Kept"]);
    });

    it("never gives the value of a password field", () => {
        const nodes = [
            node("1", { role: "rootwebarea" }, ["2", "3"]),
            node("2", { role: "textbox", name: "Password", value: "hunter2" }),
            node("3", { role: "textbox", name: "User", value: "milana" }),
        ];
        const entries = a11yEntries(nodes, { ...defaults, isPassword: (id) => id === 2 });

        expect(entries[0]?.value).toBeUndefined();
        expect(entries[1]?.value).toBe("milana");
    });

    it("starts at the given node for a subtree", () => {
        const entries = a11yEntries(tree(), { ...defaults, startBackendNode: 3 });

        expect(entries[0]).toMatchObject({ role: "main", depth: 0 });
        expect(entries.map((entry) => entry.role)).not.toContain("banner");
    });

    it("survives a cycle and a child that is missing", () => {
        const nodes = [
            node("1", { role: "main" }, ["2", "99"]),
            node("2", { role: "link", name: "Loop" }, ["1"]),
        ];

        expect(a11yEntries(nodes, { ...defaults, startBackendNode: 1 })).toHaveLength(2);
    });

    it("cuts a very long name", () => {
        const nodes = [node("1", { role: "link", name: "x".repeat(500) })];
        const [entry] = a11yEntries(nodes, defaults);

        expect(entry?.name.length).toBeLessThan(210);
        expect(entry?.name.endsWith("...")).toBe(true);
    });
});

describe("summarizeA11y", () => {
    it("counts roles and the controls that have no name", () => {
        const summary = summarizeA11y(a11yEntries(tree(), defaults));

        expect(summary.interactive).toBe(4);
        expect(summary.unnamedInteractive).toBe(1);
        expect(summary.roles).toMatchObject({ link: 1, button: 1, heading: 1, main: 1 });
    });
});
