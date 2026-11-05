import { z } from "zod";
import { ToolError } from "./errors.js";

const NAME_MAX = 256;

const MATCH_LIMIT = 1000;

export const elementLocatorSchema = z
    .strictObject({
        role : z.string().min(1).max(64).optional(),
        name : z.string().min(1).max(NAME_MAX).optional(),
        text : z.string().min(1).max(NAME_MAX).optional(),
        exact: z.boolean().optional(),
        nth  : z.number().int().min(0).max(MATCH_LIMIT).optional(),
    })
    .superRefine((value, ctx) => {
        const byRole = value.role !== undefined;
        const byText = value.text !== undefined;

        if (byRole === byText) {
            ctx.addIssue({
                code   : "custom",
                message: "A locator needs exactly one of role or text.",
            });
        }

        if (value.name !== undefined && !byRole) {
            ctx.addIssue({ code: "custom", message: "name only combines with role." });
        }
    });

export type ElementLocator = z.infer<typeof elementLocatorSchema>;

export function normalizeText(text: string): string {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function nameMatches(actual: string, wanted: string, exact: boolean): boolean {
    const have = normalizeText(actual);
    const want = normalizeText(wanted);

    return exact ? have === want : have.includes(want);
}

export function describeLocator(locator: ElementLocator): string {
    if (locator.text !== undefined) {
        return `the visible text ${JSON.stringify(locator.text)}`;
    }

    return locator.name === undefined
        ? `the role ${JSON.stringify(locator.role)}`
        : `the role ${JSON.stringify(locator.role)} and the name ${JSON.stringify(locator.name)}`;
}

export function pickMatch<T>(
    matches: readonly T[],
    locator: ElementLocator,
    describe = describeLocator(locator),
): T {
    if (matches.length === 0) {
        throw new ToolError(
            `No element has ${describe}. Check it against dom_snapshot, or use a selector.`,
        );
    }

    if (locator.nth !== undefined) {
        const chosen = matches[locator.nth];

        if (chosen === undefined) {
            throw new ToolError(
                `nth ${locator.nth} is out of range: ${matches.length} element(s) have ${describe}. Pass nth from 0 to ${matches.length - 1}.`,
            );
        }

        return chosen;
    }

    const first = matches[0] as T;

    if (matches.length > 1) {
        throw new ToolError(
            `${matches.length} elements have ${describe}. Make the locator more specific, pass exact, or pass nth (0 to ${matches.length - 1}) to pick one.`,
        );
    }

    return first;
}
