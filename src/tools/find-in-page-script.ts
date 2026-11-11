export const FIND_CONTEXT_CHARS = 60;

export const FIND_NODE_BUDGET = 50000;

export const FIND_MAX_MATCHES = 50;

const PAGE_FUNCTION = `(query, caseSensitive, maxMatches, scrollIndex, contextChars, budget) => {
  const skipped = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA"]);
  const needle = caseSensitive ? query : query.toLowerCase();
  const found = [];
  let total = 0;
  let scanned = 0;
  let exhausted = false;
  const root = document.body || document.documentElement;
  const stack = root ? [root] : [];
  const visible = (element) =>
    typeof element.checkVisibility !== "function" || element.checkVisibility({ checkVisibilityCSS: true });
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.nodeType === 1) {
      if (skipped.has(node.tagName)) continue;
      const children = [];
      if (node.shadowRoot) children.push(...node.shadowRoot.childNodes);
      children.push(...node.childNodes);
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
      continue;
    }
    if (node.nodeType !== 3) continue;
    scanned += 1;
    if (scanned > budget) { exhausted = true; break; }
    const text = node.nodeValue || "";
    const folded = caseSensitive ? text : text.toLowerCase();
    let sourceOffset = 0;
    let foldedOffset = 0;
    let previousSource = 0;
    let previousFolded = 0;
    const originalOffset = (position, isEnd) => {
      if (folded.length === text.length) return position;
      while (foldedOffset < position) {
        previousSource = sourceOffset;
        previousFolded = foldedOffset;
        const character = String.fromCodePoint(text.codePointAt(sourceOffset));
        sourceOffset += character.length;
        foldedOffset += character.toLowerCase().length;
      }
      if (position > previousFolded && position < foldedOffset) {
        if (sourceOffset - previousSource === foldedOffset - previousFolded) return previousSource + position - previousFolded;
        return isEnd ? sourceOffset : previousSource;
      }
      return sourceOffset;
    };
    let from = 0;
    for (let at = folded.indexOf(needle, from); at !== -1; at = folded.indexOf(needle, from)) {
      from = at + Math.max(1, needle.length);
      const start = originalOffset(at, false);
      const end = originalOffset(at + needle.length, true);
      const element = node.parentElement;
      if (!element || !visible(element)) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const box = range.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      total += 1;
      if (found.length < maxMatches) {
        found.push({
          range,
          element,
          context: text.slice(Math.max(0, start - contextChars), end + contextChars).replace(/\\s+/g, " ").trim(),
        });
      }
    }
  }
  let scrolled = false;
  const chosen = scrollIndex >= 0 ? found[scrollIndex] : undefined;
  if (chosen) {
    chosen.element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    scrolled = true;
  }
  const matches = found.map((entry) => {
    const box = entry.range.getBoundingClientRect();
    const inViewport = box.bottom > 0 && box.right > 0 && box.top < window.innerHeight && box.left < window.innerWidth;
    return {
      context: entry.context,
      tag: entry.element.tagName.toLowerCase(),
      rect: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
      inViewport,
    };
  });
  return { total, exhausted, scrolled, matches };
}`;

export interface FindOptions {
    query        : string;
    caseSensitive: boolean;
    maxMatches   : number;
    scrollIndex  : number;
}

export function findExpression(options: FindOptions): string {
    const args = [
        JSON.stringify(options.query),
        String(options.caseSensitive),
        String(options.maxMatches),
        String(options.scrollIndex),
        String(FIND_CONTEXT_CHARS),
        String(FIND_NODE_BUDGET),
    ];

    return `(${PAGE_FUNCTION})(${args.join(", ")})`;
}
