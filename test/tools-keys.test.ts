import { describe, expect, it } from "vitest";
import {
    acceptedKeyNames,
    editingCommand,
    keyHints,
    lookupKey,
    modifiersMask,
    modifierSpec,
    parseKeyChord,
    planKeyPress,
    planTypedChar,
    producedText,
    resolveControlOrMeta,
} from "../src/tools/index.js";

describe("lookupKey", () => {
    it("covers navigation, editing, function keys and ASCII", () => {
        expect(lookupKey("Enter")).toMatchObject({ key: "Enter", code: "Enter", windowsCode: 13 });
        expect(lookupKey("Escape")).toMatchObject({ windowsCode: 27 });
        expect(lookupKey("Tab")).toMatchObject({ windowsCode: 9 });
        expect(lookupKey("Backspace")).toMatchObject({ windowsCode: 8 });
        expect(lookupKey("Delete")).toMatchObject({ windowsCode: 46 });
        expect(lookupKey("ArrowUp")).toMatchObject({ windowsCode: 38 });
        expect(lookupKey("Home")).toMatchObject({ windowsCode: 36 });
        expect(lookupKey("PageDown")).toMatchObject({ windowsCode: 34 });
        expect(lookupKey("Space")).toMatchObject({ key: " ", code: "Space", windowsCode: 32 });
        expect(lookupKey("F1")).toMatchObject({ windowsCode: 112 });
        expect(lookupKey("F12")).toMatchObject({ windowsCode: 123 });
        expect(lookupKey("a")).toMatchObject({ key: "a", code: "KeyA", windowsCode: 65 });
        expect(lookupKey("A")).toMatchObject({ key: "A", code: "KeyA", windowsCode: 65 });
        expect(lookupKey("7")).toMatchObject({ key: "7", code: "Digit7", windowsCode: 55 });
        expect(lookupKey(";")).toMatchObject({ code: "Semicolon", windowsCode: 186 });
        expect(lookupKey("NumpadEnter")).toMatchObject({ key: "Enter", location: 3 });
    });

    it("rejects unknown names", () => {
        expect(lookupKey("Hyper")).toBeUndefined();
        expect(lookupKey("")).toBeUndefined();
        expect(lookupKey("enter")).toBeUndefined();
    });
});

describe("parseKeyChord", () => {
    it("parses a bare key", () => {
        expect(parseKeyChord("Enter")).toEqual({
            modifiers    : [],
            controlOrMeta: false,
            spec         : lookupKey("Enter"),
            shifted      : false,
        });
    });

    it("parses modifier combinations in order", () => {
        expect(parseKeyChord("Control+Shift+A")).toEqual({
            modifiers    : ["Control", "Shift"],
            controlOrMeta: false,
            spec         : lookupKey("A"),
            shifted      : true,
        });
        expect(parseKeyChord("Meta+Enter")).toEqual({
            modifiers    : ["Meta"],
            controlOrMeta: false,
            spec         : lookupKey("Enter"),
            shifted      : false,
        });
    });

    it("parses ControlOrMeta without fixing the side yet", () => {
        expect(parseKeyChord("ControlOrMeta+C")).toEqual({
            modifiers    : [],
            controlOrMeta: true,
            spec         : lookupKey("c"),
            shifted      : false,
        });
        expect(parseKeyChord("Control+C")).toMatchObject({ shifted: false });
        expect(parseKeyChord("Control+Shift+C")).toMatchObject({ shifted: true });
        expect(parseKeyChord("C")).toMatchObject({ shifted: true });
    });

    it("keeps a trailing plus as the key itself", () => {
        expect(parseKeyChord("Shift++")).toEqual({
            modifiers    : ["Shift"],
            controlOrMeta: false,
            spec         : lookupKey("+"),
            shifted      : true,
        });
        expect(parseKeyChord("a")).toMatchObject({ shifted: false });
        expect(parseKeyChord("A")).toMatchObject({ shifted: true });
        expect(parseKeyChord("!")).toMatchObject({ shifted: true });
    });

    it("accepts duplicated modifiers once and rejects unknown modifiers and empty keys", () => {
        expect(() => parseKeyChord("Hyper+A")).toThrow("Unknown modifier");
        expect(parseKeyChord("Control+Control+A").modifiers).toEqual(["Control"]);
        expect(() => parseKeyChord("Control+")).toThrow("names no key");
        expect(() => parseKeyChord("")).toThrow("names no key");
        expect(() => parseKeyChord("Control")).toThrow("names no key");
        expect(() => parseKeyChord("ControlOrMeta")).toThrow("names no key");
        expect(() => parseKeyChord("Nope")).toThrow("Unknown key");
        expect(() => parseKeyChord("+")).not.toThrow();
        expect(parseKeyChord("ControlOrMeta+ControlOrMeta+A").controlOrMeta).toBe(true);
    });

    it("lists accepted names in the error", () => {
        expect(keyHints()).toContain("Accepted key names");
        expect(acceptedKeyNames().length).toBeGreaterThan(60);
    });
});

describe("producedText", () => {
    it("returns the text for printable keys without control modifiers", () => {
        expect(producedText(lookupKey("a")!, [], false)).toBe("a");
        expect(producedText(lookupKey("a")!, ["Shift"], true)).toBe("A");
        expect(producedText(lookupKey("A")!, ["Shift"], true)).toBe("A");
        expect(producedText(lookupKey("&")!, ["Shift"], true)).toBe("&");
        expect(producedText(lookupKey("Space")!, [], false)).toBe(" ");
        expect(producedText(lookupKey("Space")!, ["Shift"], true)).toBe(" ");
    });

    it("returns undefined for command chords and control keys", () => {
        expect(producedText(lookupKey("a")!, ["Control"], false)).toBeUndefined();
        expect(producedText(lookupKey("a")!, ["Meta"], false)).toBeUndefined();
        expect(producedText(lookupKey("Enter")!, ["Control"], false)).toBeUndefined();
        expect(producedText(lookupKey("F5")!, [], false)).toBeUndefined();
    });

    it("returns carriage return for Enter without modifiers", () => {
        expect(producedText(lookupKey("Enter")!, [], false)).toBe("\r");
        expect(producedText(lookupKey("NumpadEnter")!, [], false)).toBe("\r");
    });
});

describe("resolveControlOrMeta", () => {
    it("resolves to Meta on macOS and to Control elsewhere", () => {
        expect(resolveControlOrMeta("MacIntel", [])).toEqual(["Meta"]);
        expect(resolveControlOrMeta("macOS", ["Shift"])).toEqual(["Shift", "Meta"]);
        expect(resolveControlOrMeta("Win32", [])).toEqual(["Control"]);
        expect(resolveControlOrMeta("Linux x86_64", ["Shift"])).toEqual(["Shift", "Control"]);
    });
});

describe("modifiersMask", () => {
    it("sets one bit per modifier", () => {
        expect(modifiersMask([])).toBe(0);
        expect(modifiersMask(["Alt"])).toBe(1);
        expect(modifiersMask(["Control"])).toBe(2);
        expect(modifiersMask(["Meta"])).toBe(4);
        expect(modifiersMask(["Shift"])).toBe(8);
        expect(modifiersMask(["Control", "Shift"])).toBe(10);
    });
});

describe("modifierSpec", () => {
    it("uses left side codes with location 1", () => {
        expect(modifierSpec("Control")).toEqual({
            key        : "Control",
            code       : "ControlLeft",
            windowsCode: 17,
            location   : 1,
        });
        expect(modifierSpec("Shift").code).toBe("ShiftLeft");
        expect(modifierSpec("Alt").windowsCode).toBe(18);
        expect(modifierSpec("Meta").windowsCode).toBe(91);
    });
});

describe("editingCommand", () => {
    it("maps editing shortcuts only with Control or Meta held", () => {
        expect(editingCommand("a", true)).toBe("selectAll");
        expect(editingCommand("C", true)).toBe("copy");
        expect(editingCommand("v", true)).toBe("paste");
        expect(editingCommand("x", true)).toBe("cut");
        expect(editingCommand("z", true)).toBe("undo");
        expect(editingCommand("y", true)).toBe("redo");
        expect(editingCommand("a", false)).toBeUndefined();
        expect(editingCommand("b", true)).toBeUndefined();
    });
});

describe("planKeyPress", () => {
    it("presses a bare text key as rawKeyDown, char and keyUp", () => {
        const events = planKeyPress(parseKeyChord("a"), "Win32", 1);

        expect(events).toHaveLength(3);
        expect(events[0]).toMatchObject({ type: "rawKeyDown", key: "a", text: "a", modifiers: 0 });
        expect(events[1]).toMatchObject({ type: "char", text: "a" });
        expect(events[2]).toMatchObject({ type: "keyUp", key: "a" });
        expect(events[0]?.windowsVirtualKeyCode).toBe(65);
    });

    it("presses a capital letter with an implied Shift", () => {
        const events = planKeyPress(parseKeyChord("A"), "Win32", 1);

        expect(events.map((event) => event.type)).toEqual([
            "rawKeyDown",
            "rawKeyDown",
            "char",
            "keyUp",
            "keyUp",
        ]);
        expect(events[0]).toMatchObject({ key: "Shift", modifiers: 8 });
        expect(events[1]).toMatchObject({ key: "A", text: "A", modifiers: 8 });
        expect(events[2]).toMatchObject({ type: "char", text: "A" });
        expect(events[3]).toMatchObject({ type: "keyUp", key: "A" });
        expect(events[4]).toMatchObject({ type: "keyUp", key: "Shift" });
    });

    it("presses modifiers in order and releases them in reverse with selectAll", () => {
        const events = planKeyPress(parseKeyChord("Control+Shift+A"), "Win32", 1);

        expect(events.map((event) => event.type)).toEqual([
            "rawKeyDown",
            "rawKeyDown",
            "rawKeyDown",
            "keyUp",
            "keyUp",
            "keyUp",
        ]);
        expect(events[0]).toMatchObject({ key: "Control", code: "ControlLeft", modifiers: 10 });
        expect(events[1]).toMatchObject({ key: "Shift", code: "ShiftLeft", modifiers: 10 });
        expect(events[2]).toMatchObject({
            key      : "A",
            commands : ["selectAll"],
            modifiers: 10,
        });
        expect(events[2]?.text).toBeUndefined();
        expect(events[3]).toMatchObject({ type: "keyUp", key: "A" });
        expect(events[4]).toMatchObject({ type: "keyUp", key: "Shift" });
        expect(events[5]).toMatchObject({ type: "keyUp", key: "Control" });
    });

    it("resolves ControlOrMeta per browser platform", () => {
        const mac = planKeyPress(parseKeyChord("ControlOrMeta+C"), "MacIntel", 1);
        const win = planKeyPress(parseKeyChord("ControlOrMeta+C"), "Win32", 1);

        expect(mac[0]).toMatchObject({ key: "Meta", code: "MetaLeft", modifiers: 4 });
        expect(mac[1]).toMatchObject({ key: "c", commands: ["copy"], modifiers: 4 });
        expect(win[0]).toMatchObject({ key: "Control", code: "ControlLeft", modifiers: 2 });
        expect(win[1]).toMatchObject({ key: "c", commands: ["copy"], modifiers: 2 });
    });

    it("releases every press of a repeated key", () => {
        const events = planKeyPress(parseKeyChord("b"), "Win32", 3);

        expect(events.map((event) => event.type)).toEqual([
            "rawKeyDown",
            "char",
            "keyUp",
            "rawKeyDown",
            "char",
            "keyUp",
            "rawKeyDown",
            "char",
            "keyUp",
        ]);
    });

    it("holds the modifiers across repeated presses", () => {
        const events = planKeyPress(parseKeyChord("Control+ArrowLeft"), "Win32", 2);

        expect(events.map((event) => `${event.type}:${event.key}`)).toEqual([
            "rawKeyDown:Control",
            "rawKeyDown:ArrowLeft",
            "keyUp:ArrowLeft",
            "rawKeyDown:ArrowLeft",
            "keyUp:ArrowLeft",
            "keyUp:Control",
        ]);
    });

    it("presses a duplicated Control once", () => {
        const events = planKeyPress(parseKeyChord("ControlOrMeta+Control+C"), "Win32", 1);

        expect(events.map((event) => `${event.type}:${event.key}`)).toEqual([
            "rawKeyDown:Control",
            "rawKeyDown:c",
            "keyUp:c",
            "keyUp:Control",
        ]);
    });

    it("sends the shifted character with the unshifted base for Shift chords", () => {
        const digit = planKeyPress(parseKeyChord("Shift+1"), "Win32", 1);
        const letter = planKeyPress(parseKeyChord("Shift+a"), "Win32", 1);
        const capital = planKeyPress(parseKeyChord("A"), "Win32", 1);

        expect(digit[1]).toMatchObject({ key: "!", text: "!", unmodifiedText: "1", code: "Digit1" });
        expect(digit[2]).toMatchObject({ type: "char", text: "!", unmodifiedText: "1" });
        expect(letter[1]).toMatchObject({ key: "A", text: "A", unmodifiedText: "a" });
        expect(capital[1]).toMatchObject({ key: "A", text: "A", unmodifiedText: "a" });
    });

    it("sends text and a char event for a bare Enter", () => {
        const events = planKeyPress(parseKeyChord("Enter"), "Win32", 1);

        expect(events).toHaveLength(3);
        expect(events[0]).toMatchObject({ type: "rawKeyDown", key: "Enter", modifiers: 0, text: "\r" });
        expect(events[1]).toMatchObject({ type: "char", text: "\r" });
        expect(events[2]).toMatchObject({ type: "keyUp", key: "Enter" });
        expect(events[0]?.commands).toBeUndefined();
    });

    it("carries the key location on down and up events", () => {
        const events = planKeyPress(parseKeyChord("ControlOrMeta+Enter"), "Win32", 1);

        expect(events[0]).toMatchObject({ key: "Control", location: 1 });
        expect(events[1]).toMatchObject({ key: "Enter", location: 0 });
        expect(events[2]).toMatchObject({ type: "keyUp", key: "Enter", location: 0 });
        expect(events[3]).toMatchObject({ type: "keyUp", key: "Control", location: 1 });
    });
});

describe("planTypedChar", () => {
    it("plans a lowercase character without the Shift modifier", () => {
        const events = planTypedChar("a");

        expect(events?.map((event) => event.type)).toEqual(["rawKeyDown", "char", "keyUp"]);
        expect(events?.[0]).toMatchObject({ type: "rawKeyDown", modifiers: 0, text: "a" });
        expect(events?.[1]).toMatchObject({ type: "char", text: "a" });
        expect(events?.[2]).toMatchObject({ type: "keyUp" });
    });

    it("wraps capitals in Shift down and up events", () => {
        const events = planTypedChar("A");

        expect(events?.map((event) => event.type)).toEqual([
            "rawKeyDown",
            "rawKeyDown",
            "char",
            "keyUp",
            "keyUp",
        ]);
        expect(events?.[0]).toMatchObject({ key: "Shift", code: "ShiftLeft", modifiers: 8 });
        expect(events?.[1]).toMatchObject({
            key           : "A",
            modifiers     : 8,
            text          : "A",
            unmodifiedText: "a",
        });
        expect(events?.[4]).toMatchObject({ type: "keyUp", key: "Shift" });
    });

    it("plans shifted punctuation with the Shift modifier", () => {
        const events = planTypedChar("!");

        expect(events?.[0]).toMatchObject({ key: "Shift", modifiers: 8 });
        expect(events?.[1]).toMatchObject({
            key           : "!",
            code          : "Digit1",
            modifiers     : 8,
            text          : "!",
            unmodifiedText: "1",
        });
    });

    it("returns undefined for characters outside the table", () => {
        expect(planTypedChar("\u00e9")).toBeUndefined();
        expect(planTypedChar("\ud83d\ude00")).toBeUndefined();
    });
});
