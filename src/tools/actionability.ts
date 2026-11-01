import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import {
    boxOf,
    type Rect,
    type ResolvedElement,
    revealElement,
} from "./element-target.js";
import { ToolError } from "./errors.js";

export interface ElementState {
    tag       : string;
    id        : string;
    classes   : string[];
    disabled  : boolean;
    connected : boolean;
    editable  : EditableKind;
    selectable: boolean;
    fileInput : boolean;
}

export type EditableKind = "text" | "password" | "none";

export interface HitTarget {
    tag    : string;
    id     : string;
    classes: string[];
}

export type HitResult =
    | { kind: "hit" }
    | { kind: "covered"; by: HitTarget }
    | { kind: "outside" };

export interface ActionableElement {
    state: ElementState;
    box  : Rect;
}

const stateSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z
            .object({
                tag       : z.string(),
                id        : z.string(),
                classes   : z.array(z.string()),
                disabled  : z.boolean(),
                connected : z.boolean(),
                editable  : z.enum(["text", "password", "none"]),
                selectable: z.boolean(),
                fileInput : z.boolean(),
            })
            .optional(),
    }),
});

const hitSchema = z.object({
    result: z.object({
        type : z.string().optional(),
        value: z
            .object({
                kind   : z.enum(["hit", "covered", "outside"]),
                tag    : z.string().optional(),
                id     : z.string().optional(),
                classes: z.array(z.string()).optional(),
            })
            .optional(),
    }),
});

export const STATE_EXPRESSION = `function (element) {
  const input = element instanceof HTMLInputElement ? element : null;
  const lowered = input === null ? "" : input.type.toLowerCase();
  const textTypes = new Set(["date", "datetime-local", "email", "month", "number", "search", "tel", "text", "time", "url", "week"]);
  const editable = Boolean(element.isContentEditable) ||
    element instanceof HTMLTextAreaElement ||
    lowered === "password" ||
    (input !== null && (input.type === "" || textTypes.has(lowered)));
  return {
    tag: element.localName,
    id: element.id,
    classes: [...element.classList].slice(0, 10),
    disabled: Boolean(element.disabled),
    connected: element.isConnected,
    editable: editable ? (lowered === "password" ? "password" : "text") : "none",
    selectable: element instanceof HTMLSelectElement,
    fileInput: lowered === "file",
  };
}`;

export const HIT_EXPRESSION = `function (element, x, y) {
  const point = { x: Number(x), y: Number(y) };
  const doc = element.ownerDocument;
  if (doc === null) return { kind: "outside" };
  const el = doc.elementFromPoint(point.x, point.y);
  if (el === null) return { kind: "outside" };
  if (el === element || element.contains(el)) return { kind: "hit" };
  return {
    kind: "covered",
    tag: el.localName,
    id: el.id,
    classes: [...el.classList].slice(0, 10),
  };
}`;

export function describeClasses(classes: string[]): string {
    return classes.length === 0 ? "" : `.${classes.join(".")}`;
}

export function describeTarget(target: HitTarget): string {
    const id = target.id === "" ? "" : `#${target.id}`;

    return `${target.tag}${id}${describeClasses(target.classes)}`;
}

export function coveredMessage(target: HitTarget, verb: string): string {
    return `Another element covers the target: ${describeTarget(target)}. Try click, scroll the page, or close the overlay. Pass force: true to ${verb} through it.`;
}

export async function elementState(
    access : DaemonAccess,
    tab    : string,
    element: ResolvedElement,
): Promise<ElementState> {
    const result = await access.send(tab, "Runtime.callFunctionOn", {
        functionDeclaration: STATE_EXPRESSION,
        objectId           : element.objectId,
        // callFunctionOn binds this but leaves declared parameters undefined,
        // so the element travels as the first argument too.
        arguments          : [{ objectId: element.objectId }],
        returnByValue      : true,
    });
    const parsed = stateSchema.safeParse(result);

    if (!parsed.success || parsed.data.result.type === "undefined" || parsed.data.result.value === undefined) {
        throw new ToolError(
            "The browser sent an unexpected element state. Try the call again.",
        );
    }

    const value = parsed.data.result.value;

    return {
        tag       : value.tag,
        id        : value.id,
        classes   : value.classes,
        disabled  : value.disabled,
        connected : value.connected,
        editable  : value.editable,
        selectable: value.selectable,
        fileInput : value.fileInput,
    };
}

export async function hitTest(
    access : DaemonAccess,
    tab    : string,
    element: ResolvedElement,
    point  : { x: number; y: number },
): Promise<HitResult> {
    const result = await access.send(tab, "Runtime.callFunctionOn", {
        functionDeclaration: HIT_EXPRESSION,
        objectId           : element.objectId,
        arguments          : [
            { objectId: element.objectId },
            { value: point.x },
            { value: point.y },
        ],
        returnByValue: true,
    });
    const parsed = hitSchema.safeParse(result);

    if (!parsed.success || parsed.data.result.type === "undefined" || parsed.data.result.value === undefined) {
        throw new ToolError("The browser sent an unexpected hit test result. Try the call again.");
    }

    const value = parsed.data.result.value;

    if (value.kind !== "covered") return { kind: value.kind };

    return {
        kind: "covered",
        by  : { tag: value.tag ?? "?", id: value.id ?? "", classes: value.classes ?? [] },
    };
}

export interface ActionablePoint {
    point: { x: number; y: number };
    verb : string;
}

export interface ActionabilityOptions {
    checkDisabled: boolean;
    hitTest?     : ActionablePoint | undefined;
}

function notAttachedError(): ToolError {
    return new ToolError("The element is no longer attached to the page. Take a new snapshot and try again.");
}

function hiddenError(): ToolError {
    return new ToolError(
        "The element is hidden: it has no box on the page. Make it visible and try again.",
    );
}

export async function ensureActionable(
    access : DaemonAccess,
    tab    : string,
    element: ResolvedElement,
    options: ActionabilityOptions,
): Promise<ActionableElement> {
    const state = await elementState(access, tab, element);

    if (!state.connected) throw notAttachedError();

    if (options.checkDisabled && state.disabled) {
        throw new ToolError("The element is disabled and cannot receive input.");
    }

    const box = await revealElement(access, tab, { objectId: element.objectId });

    if (box.box === null || !box.visible) throw hiddenError();

    if (options.hitTest !== undefined) {
        const hit = await hitTest(access, tab, element, options.hitTest.point);

        if (hit.kind === "covered") throw new ToolError(coveredMessage(hit.by, options.hitTest.verb));

        if (hit.kind === "outside") {
            throw new ToolError(
                "The target point lies outside the page viewport. Scroll the page and try again.",
            );
        }
    }

    return { state, box: box.box };
}

export async function readBox(
    access : DaemonAccess,
    tab    : string,
    element: ResolvedElement,
): Promise<Rect> {
    // A fresh box for hit testing: elements move between the scroll and the click.
    const box = await boxOf(access, tab, { objectId: element.objectId });

    if (box.box === null || !box.visible) throw hiddenError();

    return box.box;
}
