import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "../config/index.js";
import type { DaemonAccess } from "../mcp/index.js";
import type { ArtifactStore } from "./artifacts.js";
import type { CaptureManager } from "./capture/manager.js";
import type { DialogState } from "./dialogs.js";
import type { ElementRegistry } from "./element-target.js";
import type { InterceptionManager } from "./mock/interception.js";
import type { EmulationState } from "./emulation/state.js";
import type { ScreencastRecorder } from "./perf/screencast-recorder.js";
import type { TraceRecorder } from "./perf/trace-recorder.js";
import type { WebAuthnState } from "./webauthn-state.js";
import type { LighthouseTools } from "./perf/lighthouse-tools.js";
import type { VideoTools } from "./perf/video.js";
import type { FocusEmulation } from "./focus-emulation.js";
import type { FrameState } from "./frames.js";
import type { UploadEnvironment } from "./upload-environment.js";
import type { SafetyAccess, SafetyDecision, SafetyTarget } from "./safety.js";

type ToolAccess = SafetyAccess | ((args: unknown) => SafetyAccess);

export type { SafetyDecision };

export interface ToolClock {
    now(): number;
    sleep(ms: number): Promise<void>;
}

interface SessionState {
    readonly tabs?    : Array<{ targetId: string }>;
    readonly selected?: string;
}

export interface KnownTab {
    targetId: string;
    url     : string;
    title   : string;
    owned   : boolean;
    created : boolean;
}

interface TabSelection {
    refresh(tabs: KnownTab[], selected: string | undefined): void;
    select(targetId: string | undefined): void;
}

export interface ToolContext {
    access    : DaemonAccess;
    state     : SessionState;
    tabs      : TabSelection;
    elements  : ElementRegistry;
    frames    : FrameState;
    focus     : FocusEmulation;
    capture   : CaptureManager;
    dialogs   : DialogState;
    mock      : InterceptionManager;
    emulation : EmulationState;
    upload    : UploadEnvironment;
    trace     : TraceRecorder;
    screencast: ScreencastRecorder;
    video     : VideoTools;
    lighthouse: LighthouseTools;
    webauthn  : WebAuthnState;
    artifacts : ArtifactStore;
    config    : Config;
    clock     : ToolClock;
    signal    : AbortSignal;
    forgetTab(targetId: string): Promise<void>;
}

export interface ToolDefinition<
    TInputSchema extends z.ZodType = z.ZodType,
    TOutputSchema extends z.ZodType = z.ZodType,
> {
    name         : string;
    description  : string;
    closedWorld? : boolean;
    access       : ToolAccess;
    dangerous?   : boolean | ((args: z.output<TInputSchema>) => boolean);
    summarize?   : (args: z.output<TInputSchema>) => string;
    tabUrlExempt?: boolean | ((args: z.output<TInputSchema>) => boolean);
    input        : TInputSchema;
    output       : TOutputSchema;
    announced?   : z.ZodType;
    target?      : (args: z.output<TInputSchema>) => SafetyTarget | undefined;
    present?     : (output: z.output<TOutputSchema>) => CallToolResult;
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
