import type { AnyTool } from "./define-tool.js";
import type { SafetyAccess } from "./safety.js";

function evaluated<T>(value: T | ((args: unknown) => T), args: unknown): T {
    return typeof value === "function" ? (value as (args: unknown) => T)(args) : value;
}

export function accessFor(tool: AnyTool, args: unknown): SafetyAccess {
    return evaluated(tool.access, args);
}

export function dangerousFor(tool: AnyTool, args: unknown): boolean {
    return evaluated(tool.dangerous ?? false, args);
}

export function tabUrlExemptFor(tool: AnyTool, args: unknown): boolean {
    return evaluated(tool.tabUrlExempt ?? false, args);
}

export function mayMutate(tool: AnyTool): boolean {
    return typeof tool.access === "function" || tool.access === "mutate";
}

export function mayBeDangerous(tool: AnyTool): boolean {
    return typeof tool.dangerous === "function" || (tool.dangerous ?? false);
}
