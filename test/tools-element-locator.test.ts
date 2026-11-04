import { describe, expect, it } from "vitest";
import { elementTargetSchema, ToolError } from "../src/tools/index.js";
import {
    describeLocator,
    elementLocatorSchema,
    nameMatches,
    normalizeText,
    pickMatch,
} from "../src/tools/locator-schema.js";

describe("elementLocatorSchema", () => {
    it("takes a role with an optional name, or a text", () => {
        expect(elementLocatorSchema.safeParse({ role: "button" }).success).toBe(true);
        expect(elementLocatorSchema.safeParse({ role: "button", name: "Save", exact: true }).success)
            .toBe(true);
        expect(elementLocatorSchema.safeParse({ text: "Welcome", nth: 1 }).success).toBe(true);
    });

    it("refuses a locator that names both or neither of role and text", () => {
        expect(elementLocatorSchema.safeParse({}).success).toBe(false);
        expect(elementLocatorSchema.safeParse({ role: "button", text: "x" }).success).toBe(false);
        expect(elementLocatorSchema.safeParse({ name: "Save" }).success).toBe(false);
        expect(elementLocatorSchema.safeParse({ text: "x", name: "y" }).success).toBe(false);
        expect(elementLocatorSchema.safeParse({ role: "button", extra: 1 }).success).toBe(false);
    });
});

describe("elementTargetSchema with a locator", () => {
    it("takes a locator alone, with a frame, and refuses it next to another form or pierce", () => {
        expect(elementTargetSchema.safeParse({ locator: { role: "link" } }).success).toBe(true);
        expect(elementTargetSchema.safeParse({ locator: { role: "link" }, frame: "f1" }).success)
            .toBe(true);
        expect(elementTargetSchema.safeParse({ locator: { role: "link" }, selector: "a" }).success)
            .toBe(false);
        expect(elementTargetSchema.safeParse({ locator: { role: "link" }, uid: "1_1" }).success)
            .toBe(false);
        expect(elementTargetSchema.safeParse({ locator: { role: "link" }, pierce: true }).success)
            .toBe(false);
    });
});

describe("name matching", () => {
    it("ignores case and whitespace and matches a part unless exact", () => {
        expect(normalizeText("  Save \n  Draft ")).toBe("save draft");
        expect(nameMatches("Save draft", "SAVE", false)).toBe(true);
        expect(nameMatches("Save   draft", "save draft", true)).toBe(true);
        expect(nameMatches("Save draft", "save", true)).toBe(false);
        expect(nameMatches("", "save", false)).toBe(false);
    });
});

describe("pickMatch", () => {
    const locator = { role: "button", name: "Save" };

    it("returns the only match", () => {
        expect(pickMatch([7], locator)).toBe(7);
    });

    it("says nothing matched and points at the snapshot", () => {
        expect(() => pickMatch([], locator)).toThrow(/No element has the role "button" and the name "Save"/);
        expect(() => pickMatch([], locator)).toThrow(/dom_snapshot/);
    });

    it("refuses several matches without nth and counts them without naming page text", () => {
        try {
            pickMatch([1, 2, 3], locator);

            throw new Error("expected a refusal");
        } catch (error) {
            expect(error).toBeInstanceOf(ToolError);
            expect((error as Error).message).toContain("3 elements have");
            expect((error as Error).message).toContain("nth (0 to 2)");
        }
    });

    it("picks by nth in document order and refuses an index out of range", () => {
        expect(pickMatch([10, 20, 30], { ...locator, nth: 1 })).toBe(20);
        expect(() => pickMatch([10, 20], { ...locator, nth: 2 })).toThrow(/out of range/);
    });

    it("describes a text locator", () => {
        expect(describeLocator({ text: "Welcome" })).toBe('the visible text "Welcome"');
    });
});
