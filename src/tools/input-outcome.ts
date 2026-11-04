import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { type ElementState } from "./actionability.js";

export const targetSummarySchema = z.strictObject({
    uid    : z.string().optional().describe("Element id, when the call used one."),
    tag    : z.string().describe("Tag of the element."),
    id     : z.string().optional().describe("Id of the element, when it has one."),
    classes: z.array(z.string()).describe("Class names of the element, at most 10."),
});

type TargetSummary = z.infer<typeof targetSummarySchema>;

export function summarizeTarget(uid: string | undefined, state: ElementState): TargetSummary {
    return {
        ...(uid === undefined ? {} : { uid }),
        tag    : state.tag,
        ...(state.id === "" ? {} : { id: state.id }),
        classes: state.classes,
    };
}

export async function currentUrl(access: DaemonAccess, targetId: string): Promise<string> {
    try {
        const result = (await access.send({
            targetId,
            method: "Runtime.evaluate",
            params: {
                expression   : "location.href",
                returnByValue: true,
            },
        })) as { result?: { value?: unknown } } | null;

        return typeof result?.result?.value === "string" ? result.result.value : "";
    } catch {
        return "";
    }
}

export async function navigationOf<T>(
    access  : DaemonAccess,
    targetId: string,
    run     : () => Promise<T>,
): Promise<{ value: T; urlBefore: string; urlAfter: string }> {
    const urlBefore = await currentUrl(access, targetId);
    const value = await run();
    const urlAfter = await currentUrl(access, targetId);

    return { value, urlBefore, urlAfter };
}

export function changedUrl(urlBefore: string, urlAfter: string): { urlAfter?: string } {
    return urlBefore === "" || urlBefore === urlAfter ? {} : { urlAfter };
}
