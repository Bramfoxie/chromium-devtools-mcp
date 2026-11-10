export const EXTRACT_KINDS = ["links", "headings", "meta", "forms"] as const;

export type ExtractKind = (typeof EXTRACT_KINDS)[number];

export const EXTRACT_TEXT_CHARS = 300;

export const EXTRACT_FIELDS_PER_FORM = 50;

const PAGE_FUNCTION = `(kinds, limit, textChars, fieldLimit) => {
  const getter = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).get;
  const attr = (element, name) => Element.prototype.getAttribute.call(element, name);
  const tagOf = getter(Element.prototype, "tagName");
  const docForms = getter(Document.prototype, "forms");
  const docTitle = getter(Document.prototype, "title");
  const docRoot = getter(Document.prototype, "documentElement");
  const baseOf = getter(Node.prototype, "baseURI");
  const formControls = getter(HTMLFormElement.prototype, "elements");
  const all = (selector) => Document.prototype.querySelectorAll.call(document, selector);
  const clip = (value) => String(value == null ? "" : value).replace(/\\s+/g, " ").trim().slice(0, textChars);
  const absolute = (value) => {
    try { return new URL(value == null ? "" : String(value), baseOf.call(document)).href; } catch (error) { return ""; }
  };
  const textOf = (node) => clip(typeof node.innerText === "string" && node.innerText !== "" ? node.innerText : node.textContent);
  const take = (nodes, map) => {
    const items = [];
    let total = 0;
    for (const node of Array.from(nodes)) {
      total += 1;
      if (items.length < limit) items.push(map(node));
    }
    return { total, items };
  };
  const labelOf = (control) => {
    const labelled = control.labels && control.labels[0];
    return clip((labelled && textOf(labelled)) || attr(control, "aria-label") || attr(control, "placeholder"));
  };
  const root = docRoot.call(document);
  const canonical = all("link[rel~='canonical'][href]")[0];
  const out = {
    url: String(location.href),
    title: clip(docTitle.call(document)),
    lang: root ? clip(attr(root, "lang")) : "",
    canonical: canonical ? absolute(attr(canonical, "href")) : "",
  };
  if (kinds.includes("links")) {
    out.links = take(all("a[href]"), (a) => ({
      text: textOf(a) || clip(attr(a, "aria-label")),
      href: absolute(attr(a, "href")),
      rel: clip(attr(a, "rel")),
    }));
  }
  if (kinds.includes("headings")) {
    out.headings = take(all("h1,h2,h3,h4,h5,h6"), (h) => ({
      level: Number(tagOf.call(h).charAt(1)),
      text: textOf(h),
    }));
  }
  if (kinds.includes("meta")) {
    out.meta = take(all("meta[name],meta[property],meta[http-equiv]"), (m) => {
      const names = [attr(m, "name"), attr(m, "property"), attr(m, "http-equiv")].filter((v) => v !== null);
      return {
        name: clip(names.find((v) => v) || ""),
        names: names.map(clip),
        longName: names.some((v) => v.length > textChars),
        content: clip(attr(m, "content")),
      };
    });
  }
  if (kinds.includes("forms")) {
    out.forms = take(docForms.call(document), (form) => {
      const controls = take(formControls.call(form), (control) => ({
        tag: clip(tagOf.call(control)).toLowerCase(),
        type: clip(attr(control, "type")),
        name: clip(attr(control, "name")),
        label: labelOf(control),
        required: attr(control, "required") !== null,
      }));
      return {
        id: clip(attr(form, "id")),
        name: clip(attr(form, "name")),
        method: clip(attr(form, "method") || "get").toLowerCase(),
        action: absolute(attr(form, "action")),
        fieldTotal: controls.total,
        fields: controls.items.slice(0, fieldLimit),
      };
    });
  }
  return out;
}`;

export function extractExpression(kinds: readonly ExtractKind[], limit: number): string {
    const args = [
        JSON.stringify(kinds),
        String(limit),
        String(EXTRACT_TEXT_CHARS),
        String(EXTRACT_FIELDS_PER_FORM),
    ];

    return `(${PAGE_FUNCTION})(${args.join(", ")})`;
}
