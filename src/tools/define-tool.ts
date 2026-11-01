import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "../config/index.js";
import type { DaemonAccess } from "../mcp/index.js";
import type { CaptureManager } from "./capture/manager.js";
import type { DialogState } from "./dialogs.js";
import type { ElementRegistry } from "./element-target.js";
import type { InterceptionManager } from "./mock/interception.js";
import type { EmulationState } from "./emulation/state.js";
import type { FocusEmulation } from "./focus-emulation.js";
import type { FrameState } from "./frames.js";
import type { SafetyAccess, SafetyDecision, SafetyTarget } from "./safety.js";

export type ToolAccess = SafetyAccess;

export type { SafetyDecision };

export interface ToolClock {
    now(): number;
    sleep(ms: number): Promise<void>;
}

export interface SessionState {
    readonly tabs?    : Array<{ targetId: string }>;
    readonly selected?: string;
}

export interface KnownTabShape {
    targetId: string;
    url     : string;
    title   : string;
    owned   : boolean;
    created : boolean;
}

export interface TabSelection {
    refresh(tabs: KnownTabShape[], selected: string | undefined): void;
    select(targetId: string | undefined): void;
}

export interface ToolContext {
    access   : DaemonAccess;
    state    : SessionState;
    tabs     : TabSelection;
    elements : ElementRegistry;
    frames   : FrameState;
    focus    : FocusEmulation;
    capture  : CaptureManager;
    dialogs  : DialogState;
    mock     : InterceptionManager;
    emulation: EmulationState;
    config   : Config;
    clock    : ToolClock;
    signal   : AbortSignal;
}

export interface ToolDefinition<
    TInputSchema extends z.ZodType = z.ZodType,
    TOutputSchema extends z.ZodType = z.ZodType,
> {
    name       : string;
    description: string;
    access     : ToolAccess;
    dangerous? : boolean | ((args: z.output<TInputSchema>) => boolean);
    input      : TInputSchema;
    output     : TOutputSchema;
    announced? : z.ZodType;
    target?    : (args: z.output<TInputSchema>) => SafetyTarget | undefined;
    present?   : (output: z.output<TOutputSchema>) => CallToolResult;
    handler    : (
        args   : z.output<TInputSchema>,
        context: ToolContext,
    ) => Promise<z.output<TOutputSchema>>;
}

type AnyDefinition<I extends z.ZodType, O extends z.ZodType> = ToolDefinition<I, O>;

export function defineTool<I extends z.ZodType, O extends z.ZodType>(
    definition: AnyDefinition<I, O>,
): AnyDefinition<I, O> {
    return definition;
}

export type AnyTool = ToolDefinition<z.ZodType, z.ZodType>;
