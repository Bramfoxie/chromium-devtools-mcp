export const EXTRACT_KINDS = ["links", "headings", "meta", "forms"] as const;

export type ExtractKind = (typeof EXTRACT_KINDS)[number];

export const EXTRACT_TEXT_CHARS = 300;

export const EXTRACT_FIELDS_PER_FORM = 50;

const PAGE_FUNCTION = `(kinds, limit, textChars, fieldLimit) => {
  const clip = (value) => String(value == null ? "" : value).replace(/\\s+/g, " ").trim().slice(0, textChars);
  const take = (nodes, map) => {
    const items = [];
    let total = 0;
    for (const node of nodes) {
      total += 1;
      if (items.length < limit) items.push(map(node));
    }
    return { total, items };
  };
  const labelOf = (control) => {
    const labelled = control.labels && control.labels[0];
    return clip((labelled && (labelled.innerText || labelled.textContent)) || control.getAttribute("aria-label") || control.getAttribute("placeholder"));
  };
  const out = {
    url: location.href,
    title: document.title,
    lang: document.documentElement ? document.documentElement.lang : "",
    canonical: (document.querySelector("link[rel~='canonical'][href]") || {}).href || "",
  };
  if (kinds.includes("links")) {
    out.links = take(document.querySelectorAll("a[href]"), (a) => ({
      text: clip(a.innerText || a.textContent || a.getAttribute("aria-label")),
      href: a.href,
      rel: clip(a.getAttribute("rel")),
    }));
  }
  if (kinds.includes("headings")) {
    out.headings = take(document.querySelectorAll("h1,h2,h3,h4,h5,h6"), (h) => ({
      level: Number(h.tagName.charAt(1)),
      text: clip(h.innerText || h.textContent),
    }));
  }
  if (kinds.includes("meta")) {
    out.meta = take(document.querySelectorAll("meta[name],meta[property],meta[http-equiv]"), (m) => ({
      name: clip(m.getAttribute("name") || m.getAttribute("property") || m.getAttribute("http-equiv")),
      content: clip(m.getAttribute("content")),
    }));
  }
  if (kinds.includes("forms")) {
    out.forms = take(document.forms, (form) => {
      const controls = take(form.elements, (control) => ({
        tag: control.tagName.toLowerCase(),
        type: clip(control.getAttribute("type")),
        name: clip(control.getAttribute("name")),
        label: labelOf(control),
        required: control.required === true,
      }));
      return {
        id: clip(form.id),
        name: clip(form.getAttribute("name")),
        method: clip(form.method || "get").toLowerCase(),
        action: form.action,
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
