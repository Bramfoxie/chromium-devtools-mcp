import { z } from "zod";
import { elementCollector } from "./walk-script.js";

export const QUERY_DEFAULT_LIMIT = 20;

export const QUERY_MAX_LIMIT = 200;

export const QUERY_MAX_TEXT_CANDIDATES = 2000;

export const QUERY_CLIP_CHARS = 200;

export const DEFAULT_QUERY_ATTRIBUTES = [
    "id",
    "class",
    "name",
    "type",
    "href",
    "src",
    "value",
    "placeholder",
    "aria-label",
    "role",
    "data-testid",
];

export const describedSchema = z.object({
    node: z.object({
        nodeName     : z.string(),
        localName    : z.string().optional(),
        backendNodeId: z.number(),
        attributes   : z.array(z.string()).optional(),
    }),
});

export const rowSchema = z.object({
    index     : z.number(),
    tag       : z.string(),
    id        : z.string(),
    classes   : z.array(z.string()),
    attributes: z.record(z.string(), z.string()),
    text      : z.string(),
    visible   : z.boolean(),
    rect      : z.object({
        x     : z.number(),
        y     : z.number(),
        width : z.number(),
        height: z.number(),
    }),
});

export const rowsSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z.object({
            rows     : z.array(rowSchema),
            truncated: z.boolean(),
            total    : z.number(),
        }).optional(),
    }),
});

export type QueryRow = z.infer<typeof rowSchema>;

export function buildQueryScript(selector: string, count: number): string {
    return `(() => {
  ${elementCollector(selector, false, count)}
  found.walkTruncated = walkTruncated;
  found.total = total;
  return found;
})()`;
}

export function buildPiercedQueryScript(selector: string, count: number): string {
    return `(() => {
  ${elementCollector(selector, true, count)}
  found.walkTruncated = walkTruncated;
  found.total = total;
  return found;
})()`;
}

export function buildRowsFunction(attributes: string[]): string {
    const names = JSON.stringify(attributes);

    return `function () {
  const rows = this.map((el, index) => {
    const rect = el.getBoundingClientRect();
    const kept = {};
    for (const name of ${names}) {
      const value = el.getAttribute(name);
      if (value !== null) kept[name] = value.slice(0, 500);
    }
    return {
      index,
      tag: el.localName,
      id: el.id,
      classes: [...el.classList],
      attributes: kept,
      text: (el.innerText ?? "").slice(0, 500),
      visible: el.getClientRects().length > 0,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
  return { rows, truncated: this.walkTruncated === true, total: this.total };
}`;
}

export function clipValue(value: string, limit: number = QUERY_CLIP_CHARS): string {
    return value.length <= limit ? value : value.slice(0, limit);
}

export function roundRect(rect: QueryRow["rect"]): QueryRow["rect"] {
    return {
        x     : Math.round(rect.x),
        y     : Math.round(rect.y),
        width : Math.round(rect.width),
        height: Math.round(rect.height),
    };
}

export interface DescribedNode {
    backendNodeId: number;
    password     : boolean;
}

export function isPasswordInput(flat: string[]): boolean {
    for (let i = 0; i + 1 < flat.length; i += 2) {
        if (flat[i] === "type" && (flat[i + 1] ?? "").toLowerCase() === "password") return true;
    }

    return false;
}

export const matchSchema = z.strictObject({
    uid       : z.string().describe("Element id for later calls."),
    tag       : z.string().describe("Lowercase tag name."),
    id        : z.string().describe("Element id, empty when absent."),
    classes   : z.array(z.string()).describe("Class names."),
    attributes: z.record(z.string(), z.string()).describe(`Requested attributes, values clipped to ${QUERY_CLIP_CHARS} characters.`),
    text      : z.string().describe(`Visible text, clipped to ${QUERY_CLIP_CHARS} characters.`),
    visible   : z.boolean().describe("Whether the element has a rendered box."),
    box       : z.strictObject({
        x     : z.number().describe("Left edge in CSS pixels."),
        y     : z.number().describe("Top edge in CSS pixels."),
        width : z.number().describe("Width in CSS pixels."),
        height: z.number().describe("Height in CSS pixels."),
    }).nullable().describe("Bounding box, null when includeBox is false or the element has none."),
    redacted: z.boolean().optional().describe("True when a password value was hidden."),
});
