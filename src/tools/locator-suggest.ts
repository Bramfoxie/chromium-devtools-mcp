import type { A11yEntry } from "./a11y-tree.js";
import { type ElementLocator, nameMatches, normalizeText } from "./locator-schema.js";

// The shortest locator that finds exactly this node again with the matching of the locator target:
// a part of the name first, the whole name next, and the position among equals as the last resort.
export function pickLocator(
    entries      : readonly A11yEntry[],
    backendNodeId: number,
): ElementLocator | undefined {
    const target = entries.find((entry) => entry.backendNodeId === backendNodeId);

    if (target === undefined || target.name === "" || target.role === "text") return undefined;

    const sameRole = entries.filter((entry) => entry.role === target.role);
    const partial = sameRole.filter((entry) => nameMatches(entry.name, target.name, false));

    if (partial.length === 1) return { role: target.role, name: target.name };

    const wanted = normalizeText(target.name);
    const exact = sameRole.filter((entry) => normalizeText(entry.name) === wanted);

    if (exact.length === 1) return { role: target.role, name: target.name, exact: true };

    return { role: target.role, name: target.name, exact: true, nth: exact.indexOf(target) };
}
