import vm from "node:vm";
import { ToolError } from "../errors.js";

export const NETWORK_REGEX_MAX_CHARS = 200;

const NETWORK_URL_MATCH_CHARS = 2048;

const NETWORK_REGEX_TIMEOUT_MS = 50;

const NETWORK_REGEX_MAX_UNBOUNDED = 2;

const QUANTIFIER_BRACES = /^\{(\d+)(?:(,)(\d*))?\}/;

interface PatternGroup {
    quantified: boolean;
    alternated: boolean;
}

function unsafePattern(pattern: string): boolean {
    const stack: PatternGroup[] = [];
    let current: PatternGroup = { quantified: false, alternated: false };
    let lastGroup: PatternGroup | undefined;
    let unbounded = 0;
    let index = 0;

    while (index < pattern.length) {
        const char = pattern.charAt(index);
        let quantifier: { repeats: boolean; unbounded: boolean } | undefined;
        let length = 1;

        if (char === "\\") {
            if (/[1-9k]/.test(pattern.charAt(index + 1))) return true;

            length = 2;
            lastGroup = undefined;
        } else if (char === "[") {
            let end = index + 1;

            while (end < pattern.length && pattern.charAt(end) !== "]") {
                end += pattern.charAt(end) === "\\" ? 2 : 1;
            }

            length = end + 1 - index;
            lastGroup = undefined;
        } else if (char === "(") {
            if (pattern.startsWith("(?", index) && !pattern.startsWith("(?:", index)) return true;

            stack.push(current);
            current = { quantified: false, alternated: false };
            lastGroup = undefined;

            if (pattern.startsWith("(?:", index)) length = 3;
        } else if (char === ")") {
            const parent = stack.pop();

            if (parent === undefined) return true;

            const closed = current;

            current = parent;
            current.quantified ||= closed.quantified;
            current.alternated ||= closed.alternated;
            lastGroup = closed;
        } else if (char === "|") {
            current.alternated = true;
            lastGroup = undefined;
        } else if (char === "*" || char === "+") {
            quantifier = { repeats: true, unbounded: true };
        } else if (char === "?") {
            quantifier = { repeats: false, unbounded: false };
        } else if (char === "{") {
            const match = QUANTIFIER_BRACES.exec(pattern.slice(index));

            if (match !== null) {
                const open = match[2] !== undefined && match[3] === "";
                const max = open ? Infinity : Number(match[3] || match[1]);

                quantifier = { repeats: max > 1, unbounded: open };
                length = match[0].length;
            } else {
                lastGroup = undefined;
            }
        } else {
            lastGroup = undefined;
        }

        if (quantifier !== undefined) {
            if (quantifier.repeats && lastGroup !== undefined) {
                if (lastGroup.quantified || lastGroup.alternated) return true;
            }

            current.quantified = true;

            if (quantifier.unbounded) unbounded += 1;

            lastGroup = undefined;

            if (pattern.charAt(index + length) === "?") length += 1;
        }

        index += length;
    }

    return stack.length > 0 || unbounded > NETWORK_REGEX_MAX_UNBOUNDED;
}

export interface UrlPattern {
    test(url: string): boolean;
}

function sandboxedPattern(pattern: string, timeoutMs: number): UrlPattern {
    const context = vm.createContext(Object.create(null) as object);
    const source = JSON.stringify(pattern);

    vm.runInContext(`globalThis.matcher = new RegExp(${source});`, context);
    const run = new vm.Script("matcher.test(subject)");

    return {
        test: (url) => {
            context.subject = url;

            try {
                return run.runInContext(context, { timeout: timeoutMs }) === true;
            } catch {
                throw new ToolError(
                    `The urlRegex took longer than ${timeoutMs} ms on a URL and was stopped. Use a simpler pattern with fewer repeats.`,
                );
            }
        },
    };
}

export function compileUrlPattern(
    pattern  : string,
    timeoutMs: number = NETWORK_REGEX_TIMEOUT_MS,
): UrlPattern {
    if (pattern.length > NETWORK_REGEX_MAX_CHARS) {
        throw new Error(`The pattern is longer than ${NETWORK_REGEX_MAX_CHARS} characters.`);
    }

    try {
        new RegExp(pattern);
    } catch {
        throw new Error("The pattern is not a valid regular expression.");
    }

    if (unsafePattern(pattern)) {
        throw new Error(
            "The pattern could be slow on long URLs. Use at most 2 unbounded repeats (*, + or {n,}), no repeated groups that contain repeats or alternation, no backreferences and no lookarounds.",
        );
    }

    return sandboxedPattern(pattern, timeoutMs);
}

export function testUrlPattern(pattern: UrlPattern, url: string): boolean {
    return pattern.test(url.slice(0, NETWORK_URL_MATCH_CHARS));
}
