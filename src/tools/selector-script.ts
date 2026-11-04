// Runs in the page on the element. Returns { selector, unique, frame? }, relative to the document
// of the element; a shadow root continues the chain with " >>> ", a same-origin iframe gives its own
// selector in "frame".
export const SELECTOR_EXPRESSION = `function (element) {
  const ATTRS = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa", "name", "aria-label", "placeholder", "alt", "title"];
  const unstableClass = (name) =>
    name.length > 40 || /\\d{3,}/.test(name) || /^(css|sc|jsx|svelte|emotion)-/i.test(name) || /^_/.test(name);
  const quote = (value) => '"' + value.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"') + '"';
  const count = (scope, selector) => {
    try { return scope.querySelectorAll(selector).length; } catch (error) { return -1; }
  };
  const isUnique = (scope, selector, el) => {
    try { return scope.querySelectorAll(selector).length === 1 && scope.querySelector(selector) === el; }
    catch (error) { return false; }
  };

  function within(el) {
    const scope = el.getRootNode();
    const tag = el.tagName.toLowerCase();

    if (el.id) {
      const byId = "#" + CSS.escape(el.id);
      if (isUnique(scope, byId, el)) return { selector: byId, unique: true };
      if (isUnique(scope, tag + byId, el)) return { selector: tag + byId, unique: true };
    }

    for (const name of ATTRS) {
      const value = el.getAttribute(name);
      if (!value || value.length > 80) continue;
      const selector = tag + "[" + name + "=" + quote(value) + "]";
      if (isUnique(scope, selector, el)) return { selector, unique: true };
    }

    const classes = [...el.classList].filter((name) => !unstableClass(name)).slice(0, 4);
    for (const name of classes) {
      const selector = tag + "." + CSS.escape(name);
      if (isUnique(scope, selector, el)) return { selector, unique: true };
    }
    for (let i = 0; i < classes.length; i += 1) {
      for (let j = i + 1; j < classes.length; j += 1) {
        const selector = tag + "." + CSS.escape(classes[i]) + "." + CSS.escape(classes[j]);
        if (isUnique(scope, selector, el)) return { selector, unique: true };
      }
    }

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let part = node.tagName.toLowerCase();
      if (node.id && count(scope, "#" + CSS.escape(node.id)) === 1) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      const parent = node.parentElement;
      const siblings = parent ? [...parent.children].filter((child) => child.tagName === node.tagName) : [];
      if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      parts.unshift(part);
      const selector = parts.join(" > ");
      if (isUnique(scope, selector, el)) return { selector, unique: true };
      node = parent;
    }
    const selector = parts.join(" > ");
    return { selector, unique: isUnique(scope, selector, el) };
  }

  function build(el, depth) {
    const found = within(el);
    const root = el.getRootNode();
    if (typeof ShadowRoot === "function" && root instanceof ShadowRoot && depth < 5) {
      const host = build(root.host, depth + 1);
      return { selector: host.selector + " >>> " + found.selector, unique: found.unique && host.unique, frame: host.frame };
    }
    return found;
  }

  const result = build(element, 0);
  const view = element.ownerDocument.defaultView;
  let frame;
  try {
    const owner = view && view.frameElement;
    if (owner) frame = build(owner, 0).selector;
  } catch (error) {
    frame = undefined;
  }
  return { selector: result.selector, unique: result.unique, frame: result.frame || frame };
}`;
