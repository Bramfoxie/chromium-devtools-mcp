import { ToolError } from "./errors.js";

export const KEY_MODIFIERS = ["Alt", "Control", "Meta", "Shift"] as const;

export type KeyModifier = (typeof KEY_MODIFIERS)[number];

export const MODIFIER_BITS: Record<KeyModifier, number> = {
    Alt    : 1,
    Control: 2,
    Meta   : 4,
    Shift  : 8,
};

export interface KeySpec {
    key        : string;
    code       : string;
    windowsCode: number;
    location?  : number;
}

const EDITABLE_COMMANDS: Record<string, string> = {
    a: "selectAll",
    c: "copy",
    v: "paste",
    x: "cut",
    z: "undo",
    y: "redo",
};

export function editingCommand(key: string, controlOrMeta: boolean): string | undefined {
    if (!controlOrMeta) return undefined;

    return EDITABLE_COMMANDS[key.toLowerCase()];
}

function buildTable(): Map<string, KeySpec> {
    const table = new Map<string, KeySpec>();
    const put = (name: string, spec: KeySpec): void => {
        table.set(name, spec);
    };

    put("Backspace", { key: "Backspace", code: "Backspace", windowsCode: 8 });
    put("Tab", { key: "Tab", code: "Tab", windowsCode: 9 });
    put("Enter", { key: "Enter", code: "Enter", windowsCode: 13, location: 0 });
    put("NumpadEnter", { key: "Enter", code: "NumpadEnter", windowsCode: 13, location: 3 });
    put("Escape", { key: "Escape", code: "Escape", windowsCode: 27 });
    put("Space", { key: " ", code: "Space", windowsCode: 32 });
    put("PageUp", { key: "PageUp", code: "PageUp", windowsCode: 33 });
    put("PageDown", { key: "PageDown", code: "PageDown", windowsCode: 34 });
    put("End", { key: "End", code: "End", windowsCode: 35 });
    put("Home", { key: "Home", code: "Home", windowsCode: 36 });
    put("ArrowLeft", { key: "ArrowLeft", code: "ArrowLeft", windowsCode: 37 });
    put("ArrowUp", { key: "ArrowUp", code: "ArrowUp", windowsCode: 38 });
    put("ArrowRight", { key: "ArrowRight", code: "ArrowRight", windowsCode: 39 });
    put("ArrowDown", { key: "ArrowDown", code: "ArrowDown", windowsCode: 40 });
    put("Insert", { key: "Insert", code: "Insert", windowsCode: 45 });
    put("Delete", { key: "Delete", code: "Delete", windowsCode: 46 });

    for (let digit = 0; digit <= 9; digit += 1) {
        const text = String(digit);

        put(text, { key: text, code: `Digit${text}`, windowsCode: 48 + digit });
    }

    for (const letter of "abcdefghijklmnopqrstuvwxyz") {
        const upper = letter.toUpperCase();

        put(letter, { key: letter, code: `Key${upper}`, windowsCode: upper.charCodeAt(0) });
        put(upper, { key: upper, code: `Key${upper}`, windowsCode: upper.charCodeAt(0) });
    }

    for (let index = 1; index <= 12; index += 1) {
        const name = `F${index}`;

        put(name, { key: name, code: name, windowsCode: 111 + index });
    }

    const punctuation: Array<[string, string, number]> = [
        [";", "Semicolon", 186],
        ["=", "Equal", 187],
        [",", "Comma", 188],
        ["-", "Minus", 189],
        [".", "Period", 190],
        ["/", "Slash", 191],
        ["`", "Backquote", 192],
        ["[", "BracketLeft", 219],
        ["\\", "Backslash", 220],
        ["]", "BracketRight", 221],
        ["'", "Quote", 222],
    ];

    for (const [text, code, windowsCode] of punctuation) {
        put(text, { key: text, code, windowsCode });
    }

    // Shifted printable keys: CDP takes the produced character as key plus the Shift modifier.
    const shifted: Array<[string, string, number]> = [
        ["!", "Digit1", 49],
        ["@", "Digit2", 50],
        ["#", "Digit3", 51],
        ["$", "Digit4", 52],
        ["%", "Digit5", 53],
        ["^", "Digit6", 54],
        ["&", "Digit7", 55],
        ["*", "Digit8", 56],
        ["(", "Digit9", 57],
        [")", "Digit0", 48],
        ["_", "Minus", 189],
        ["+", "Equal", 187],
        ["{", "BracketLeft", 219],
        ["}", "BracketRight", 221],
        ["|", "Backslash", 220],
        [":", "Semicolon", 186],
        ["\"", "Quote", 222],
        ["<", "Comma", 188],
        [">", "Period", 190],
        ["?", "Slash", 191],
        ["~", "Backquote", 192],
    ];

    for (const [text, code, windowsCode] of shifted) put(text, { key: text, code, windowsCode });

    return table;
}

const TABLE = buildTable();

function buildShiftMaps(): { shiftedOf: Map<string, string>; baseOf: Map<string, string> } {
    const shiftedOf = new Map<string, string>();
    const baseOf = new Map<string, string>();
    const pair = (base: string, shifted: string): void => {
        shiftedOf.set(base, shifted);
        baseOf.set(shifted, base);
    };

    for (const letter of "abcdefghijklmnopqrstuvwxyz") pair(letter, letter.toUpperCase());

    const baseByCode = new Map<string, string>();

    for (const spec of TABLE.values()) {
        if (spec.key.length === 1 && !/[A-Z]/.test(spec.key) && !baseByCode.has(spec.code)) {
            baseByCode.set(spec.code, spec.key);
        }
    }

    for (const spec of TABLE.values()) {
        const base = baseByCode.get(spec.code);

        if (base !== undefined && base !== spec.key && !/[A-Z]/.test(spec.key)) {
            pair(base, spec.key);
        }
    }

    return { shiftedOf, baseOf };
}

const SHIFT_MAPS = buildShiftMaps();

export function shiftedKey(key: string): string {
    return SHIFT_MAPS.shiftedOf.get(key) ?? key;
}

export function unshiftedKey(key: string): string {
    return SHIFT_MAPS.baseOf.get(key) ?? key;
}

export function acceptedKeyNames(): string[] {
    return [...TABLE.keys()];
}

export function lookupKey(name: string): KeySpec | undefined {
    return TABLE.get(name);
}

export interface ParsedKey {
    modifiers    : KeyModifier[];
    controlOrMeta: boolean;
    spec         : KeySpec;
    shifted      : boolean;
}

export function keyHints(): string {
    const names = acceptedKeyNames();

    return `Accepted key names are ${names.slice(0, 8).join(", ")}, ... F1 to F12, letters, digits and US punctuation.`;
}

function isKeyModifier(part: string): part is KeyModifier {
    return (KEY_MODIFIERS as readonly string[]).includes(part);
}

export function parseKeyChord(text: string): ParsedKey {
    const plusKey = text === "+" || text.endsWith("++");
    const chord = plusKey ? text.slice(0, -1) : text;
    const parts = chord.split("+");
    const modifiers: KeyModifier[] = [];
    let controlOrMeta = false;

    for (const part of parts.slice(0, -1)) {
        if (part === "ControlOrMeta") {
            controlOrMeta = true;
            continue;
        }

        if (!isKeyModifier(part)) {
            throw new ToolError(
                `Unknown modifier ${JSON.stringify(part)} in key ${JSON.stringify(text)}. ${keyHints()}`,
            );
        }

        if (!modifiers.includes(part)) modifiers.push(part);
    }

    const name = plusKey ? "+" : (parts[parts.length - 1] ?? "");

    if (name === "" || isKeyModifier(name) || name === "ControlOrMeta") {
        throw new ToolError(
            `The key ${JSON.stringify(text)} names no key. Name a key after the last "+". ${keyHints()}`,
        );
    }

    let spec = lookupKey(name);

    if (spec === undefined) {
        throw new ToolError(`Unknown key ${JSON.stringify(text)}. ${keyHints()}`);
    }

    if (
        (modifiers.length > 0 || controlOrMeta) && /^[A-Z]$/.test(spec.key) &&
        modifiers.every((modifier) => modifier !== "Shift")
    ) {
        spec = lookupKey(spec.key.toLowerCase()) ?? spec;
    }

    const shifted = needsShift(spec.key);

    return { modifiers, controlOrMeta, spec, shifted };
}

function needsShift(key: string): boolean {
    if (key.length !== 1) return false;
    if (/[A-Z]/.test(key)) return true;

    return "!@#$%^&*()_+{}|:\"<>?~".includes(key);
}

export function producedText(
    spec     : KeySpec,
    modifiers: KeyModifier[],
    shiftHeld: boolean,
): string | undefined {
    if (modifiers.includes("Control") || modifiers.includes("Alt") || modifiers.includes("Meta")) {
        return undefined;
    }

    // Enter inserts a carriage return: without it forms do not submit and
    // text areas get no newline. No text when combined with modifiers.
    if (spec.key === "Enter") return "\r";

    if (spec.key.length > 1) {
        return spec.key === " " ? " " : undefined;
    }

    return shiftHeld ? shiftedKey(spec.key) : spec.key;
}

export function modifiersMask(modifiers: KeyModifier[]): number {
    let mask = 0;

    for (const modifier of modifiers) mask |= MODIFIER_BITS[modifier];

    return mask;
}

export function resolveControlOrMeta(platform: string, modifiers: KeyModifier[]): KeyModifier[] {
    const resolved: KeyModifier = /mac/i.test(platform) ? "Meta" : "Control";

    return modifiers.includes(resolved) ? [...modifiers] : [...modifiers, resolved];
}

export interface KeyEventPlan {
    type                 : "rawKeyDown" | "char" | "keyUp";
    key                  : string;
    code                 : string;
    windowsVirtualKeyCode: number;
    modifiers            : number;
    text?                : string;
    unmodifiedText?      : string;
    location?            : number;
    commands?            : string[];
}

export function planKeyPress(parsed: ParsedKey, platform: string, repeat: number): KeyEventPlan[] {
    const bare = parsed.controlOrMeta
        ? resolveControlOrMeta(platform, parsed.modifiers)
        : [...parsed.modifiers];
    const shiftImplied = parsed.shifted && !bare.includes("Shift");
    const held = shiftImplied ? [...bare, "Shift" as KeyModifier] : bare;
    const mask = modifiersMask(held);
    const downOrder: KeyModifier[] = shiftImplied ? ["Shift", ...bare] : [...bare];
    const upOrder = [...downOrder].reverse();
    const command = editingCommand(parsed.spec.key, held.includes("Control") || held.includes("Meta"));
    const events: KeyEventPlan[] = [];

    for (const modifier of downOrder) {
        const spec = modifierSpec(modifier);

        events.push({
            type                 : "rawKeyDown",
            key                  : spec.key,
            code                 : spec.code,
            windowsVirtualKeyCode: spec.windowsCode,
            modifiers            : mask,
            ...(spec.location === undefined ? {} : { location: spec.location }),
        });
    }

    const shiftHeld = held.includes("Shift");
    const key = shiftHeld ? shiftedKey(parsed.spec.key) : parsed.spec.key;
    const location = parsed.spec.location === undefined ? {} : { location: parsed.spec.location };

    for (let press = 0; press < repeat; press += 1) {
        const text = producedText(parsed.spec, held, shiftHeld);
        const params: KeyEventPlan = {
            type                 : "rawKeyDown",
            key,
            code                 : parsed.spec.code,
            windowsVirtualKeyCode: parsed.spec.windowsCode,
            modifiers            : mask,
            ...location,
        };

        if (text !== undefined) {
            params.text = text;
            params.unmodifiedText = unshiftedKey(text);
        }

        if (command !== undefined) params.commands = [command];

        events.push(params);

        if (text !== undefined) {
            events.push({
                type                 : "char",
                key,
                code                 : parsed.spec.code,
                windowsVirtualKeyCode: 0,
                modifiers            : mask,
                text,
                unmodifiedText       : unshiftedKey(text),
            });
        }

        events.push({
            type                 : "keyUp",
            key,
            code                 : parsed.spec.code,
            windowsVirtualKeyCode: parsed.spec.windowsCode,
            modifiers            : mask,
            ...location,
        });
    }

    for (const modifier of upOrder) {
        const spec = modifierSpec(modifier);

        events.push({
            type                 : "keyUp",
            key                  : spec.key,
            code                 : spec.code,
            windowsVirtualKeyCode: spec.windowsCode,
            modifiers            : mask,
            ...(spec.location === undefined ? {} : { location: spec.location }),
        });
    }

    return events;
}

export function modifierSpec(modifier: KeyModifier): KeySpec {
    switch (modifier) {
        case "Alt":
            return { key: "Alt", code: "AltLeft", windowsCode: 18, location: 1 };
        case "Control":
            return { key: "Control", code: "ControlLeft", windowsCode: 17, location: 1 };
        case "Meta":
            return { key: "Meta", code: "MetaLeft", windowsCode: 91, location: 1 };
        case "Shift":
            return { key: "Shift", code: "ShiftLeft", windowsCode: 16, location: 1 };
    }
}

export function planTypedChar(text: string): KeyEventPlan[] | undefined {
    const spec = lookupKey(text);

    if (spec === undefined) return undefined;

    const shift = needsShift(text);
    const mask = shift ? MODIFIER_BITS.Shift : 0;
    const events: KeyEventPlan[] = [];
    const modifier = modifierSpec("Shift");

    if (shift) {
        events.push({
            type                 : "rawKeyDown",
            key                  : modifier.key,
            code                 : modifier.code,
            windowsVirtualKeyCode: modifier.windowsCode,
            modifiers            : mask,
            ...(modifier.location === undefined ? {} : { location: modifier.location }),
        });
    }

    events.push(
        {
            type                 : "rawKeyDown",
            key                  : text,
            code                 : spec.code,
            windowsVirtualKeyCode: spec.windowsCode,
            modifiers            : mask,
            text,
            unmodifiedText       : unshiftedKey(text),
        },
        {
            type                 : "char",
            key                  : text,
            code                 : spec.code,
            windowsVirtualKeyCode: 0,
            modifiers            : mask,
            text,
            unmodifiedText       : unshiftedKey(text),
        },
        {
            type                 : "keyUp",
            key                  : text,
            code                 : spec.code,
            windowsVirtualKeyCode: spec.windowsCode,
            modifiers            : mask,
        },
    );

    if (shift) {
        events.push({
            type                 : "keyUp",
            key                  : modifier.key,
            code                 : modifier.code,
            windowsVirtualKeyCode: modifier.windowsCode,
            modifiers            : mask,
            ...(modifier.location === undefined ? {} : { location: modifier.location }),
        });
    }

    return events;
}
