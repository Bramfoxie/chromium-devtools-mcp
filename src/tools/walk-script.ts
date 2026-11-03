export const WALK_NODE_BUDGET = 20_000;

export function elementCollector(selector: string, pierce: boolean, limit?: number): string {
    const matcher = JSON.stringify(selector);
    const cap = limit === undefined ? "Infinity" : JSON.stringify(limit);

    if (!pierce) {
        return `const found = [];
  let walkTruncated = false;
  const matched = document.querySelectorAll(${matcher});
  const total = matched.length;
  for (const el of matched) {
    if (found.length >= ${cap}) break;
    if (found.length >= ${WALK_NODE_BUDGET}) { walkTruncated = true; break; }
    found.push(el);
  }`;
    }

    return `const found = [];
  let visited = 0;
  let total = 0;
  let walkTruncated = false;
  const walk = (root) => {
    for (const el of root.querySelectorAll(${matcher})) {
      total += 1;
      if (found.length < ${cap}) found.push(el);
    }
    for (const el of root.querySelectorAll("*")) {
      visited += 1;
      if (visited > ${WALK_NODE_BUDGET}) { walkTruncated = true; return true; }
      if (el.shadowRoot && walk(el.shadowRoot)) return true;
    }
    return false;
  };
  walk(document);`;
}
