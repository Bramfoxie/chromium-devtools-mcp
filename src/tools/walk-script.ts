export const WALK_NODE_BUDGET = 20_000;

export function elementCollector(selector: string, pierce: boolean, limit?: number): string {
    const matcher = JSON.stringify(selector);
    const cap = limit === undefined ? "Infinity" : JSON.stringify(limit);

    if (!pierce) {
        return `const found = [];
  let walkTruncated = false;
  for (const el of document.querySelectorAll(${matcher})) {
    if (found.length >= ${cap}) break;
    if (found.length >= ${WALK_NODE_BUDGET}) { walkTruncated = true; break; }
    found.push(el);
  }`;
    }

    return `const found = [];
  let visited = 0;
  let walkTruncated = false;
  const walk = (root) => {
    for (const el of root.querySelectorAll(${matcher})) {
      if (found.length >= ${cap}) return true;
      found.push(el);
    }
    for (const el of root.querySelectorAll("*")) {
      if (found.length >= ${cap}) return true;
      visited += 1;
      if (visited > ${WALK_NODE_BUDGET}) { walkTruncated = true; return true; }
      if (el.shadowRoot && walk(el.shadowRoot)) return true;
    }
    return false;
  };
  walk(document);`;
}
