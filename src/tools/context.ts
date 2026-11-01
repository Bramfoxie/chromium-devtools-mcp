import type { Config } from "../config/index.js";
import type { DaemonAccess, DaemonTab } from "../mcp/index.js";
import { CaptureManager } from "./capture/manager.js";
import type { ToolClock, ToolContext } from "./define-tool.js";
import { DialogState } from "./dialogs.js";
import { ElementRegistry } from "./element-target.js";
import { EmulationState } from "./emulation/state.js";
import { FocusEmulation } from "./focus-emulation.js";

export type { ToolClock, ToolContext };

export interface KnownTab {
    targetId: string;
    url     : string;
    title   : string;
    owned   : boolean;
    created : boolean;
}

export class SessionTabs {
    private known     : KnownTab[] = [];
    private selectedId: string | undefined;

    knownTabs(): KnownTab[] {
        return [...this.known];
    }

    selected(): string | undefined {
        return this.selectedId;
    }

    refresh(tabs: DaemonTab[], selected: string | undefined): void {
        this.known = tabs.map((tab) => ({ ...tab }));
        this.selectedId = selected;
    }

    select(targetId: string | undefined): void {
        this.selectedId = targetId;
    }

    forget(targetId: string): void {
        this.known = this.known.filter((tab) => tab.targetId !== targetId);
        if (this.selectedId === targetId) this.selectedId = undefined;
    }

    reset(): void {
        this.known = [];
        this.selectedId = undefined;
    }
}

export interface ToolRuntimeOptions {
    access    : DaemonAccess;
    config    : Config;
    clock?    : ToolClock;
    tabs?     : SessionTabs;
    elements? : ElementRegistry;
    focus?    : FocusEmulation;
    capture?  : CaptureManager;
    dialogs?  : DialogState;
    emulation?: EmulationState;
}

export class ToolRuntime {
    readonly access   : DaemonAccess;
    readonly config   : Config;
    readonly clock    : ToolClock;
    readonly tabs     : SessionTabs;
    readonly elements : ElementRegistry;
    readonly focus    : FocusEmulation;
    readonly capture  : CaptureManager;
    readonly dialogs  : DialogState;
    readonly emulation: EmulationState;

    constructor(options: ToolRuntimeOptions) {
        this.access = options.access;
        this.config = options.config;
        this.clock = options.clock ?? {
            now  : () => Date.now(),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        };
        this.tabs = options.tabs ?? new SessionTabs();
        this.elements = options.elements ?? new ElementRegistry();
        this.focus = options.focus ?? new FocusEmulation();
        this.capture = options.capture ??
            new CaptureManager({ access: options.access, clock: this.clock });
        this.dialogs = options.dialogs ??
            new DialogState({ access: options.access, clock: this.clock });
        this.emulation = options.emulation ?? new EmulationState();
    }

    context(signal: AbortSignal): ToolContext {
        const tabs = this.tabs;

        return {
            access   : this.access,
            tabs,
            elements : this.elements,
            focus    : this.focus,
            capture  : this.capture,
            dialogs  : this.dialogs,
            emulation: this.emulation,
            config   : this.config,
            clock    : this.clock,
            signal,
            state    : {
                get tabs() {
                    return tabs.knownTabs();
                },
                get selected() {
                    return tabs.selected();
                },
            },
        };
    }
}
