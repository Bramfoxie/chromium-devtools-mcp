import type { Config } from "../config/index.js";
import type { DaemonAccess, DaemonTab } from "../mcp/index.js";
import { confirmedAccess, type Confirmer } from "./confirmation.js";
import { CaptureManager } from "./capture/manager.js";
import type { KnownTab, ToolClock, ToolContext } from "./define-tool.js";
import { DialogState } from "./dialogs.js";
import { ElementRegistry } from "./element-target.js";
import { EmulationState } from "./emulation/state.js";
import { nodeUploadEnvironment, type UploadEnvironment } from "./upload-environment.js";
import { FocusEmulation } from "./focus-emulation.js";
import { FrameState } from "./frames.js";
import { InterceptionManager } from "./mock/interception.js";
import { sleep } from "../util/sleep.js";

export type { ToolClock, ToolContext };

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

interface ToolRuntimeOptions {
    access    : DaemonAccess;
    config    : Config;
    clock?    : ToolClock;
    tabs?     : SessionTabs;
    elements? : ElementRegistry;
    frames?   : FrameState;
    focus?    : FocusEmulation;
    capture?  : CaptureManager;
    dialogs?  : DialogState;
    mock?     : InterceptionManager;
    emulation?: EmulationState;
    upload?   : UploadEnvironment;
    confirm?  : Confirmer;
}

export class ToolRuntime {
    readonly access   : DaemonAccess;
    readonly config   : Config;
    readonly clock    : ToolClock;
    readonly tabs     : SessionTabs;
    readonly elements : ElementRegistry;
    readonly frames   : FrameState;
    readonly focus    : FocusEmulation;
    readonly capture  : CaptureManager;
    readonly dialogs  : DialogState;
    readonly mock     : InterceptionManager;
    readonly emulation: EmulationState;
    readonly upload   : UploadEnvironment;
    readonly confirm  : Confirmer | undefined;

    constructor(options: ToolRuntimeOptions) {
        this.access = options.access;
        this.config = options.config;
        this.clock = options.clock ?? {
            now: () => Date.now(),
            sleep,
        };
        this.tabs = options.tabs ?? new SessionTabs();
        this.elements = options.elements ?? new ElementRegistry();
        this.frames = options.frames ?? new FrameState({ access: options.access });
        this.frames.onNavigated((tab, frameId, main) => {
            if (main) this.elements.nextGeneration(tab);
            else this.elements.invalidateFrame(tab, frameId);
        });
        this.focus = options.focus ?? new FocusEmulation();
        this.capture = options.capture ??
            new CaptureManager({ access: options.access, clock: this.clock });
        this.dialogs = options.dialogs ??
            new DialogState({ access: options.access, clock: this.clock });
        this.mock = options.mock ??
            new InterceptionManager({ access: options.access, clock: this.clock });
        this.emulation = options.emulation ?? new EmulationState();
        this.upload = options.upload ?? nodeUploadEnvironment();
        this.confirm = options.confirm;
    }

    context(signal: AbortSignal, confirmed = false): ToolContext {
        const tabs = this.tabs;

        return {
            access   : confirmed ? confirmedAccess(this.access) : this.access,
            tabs,
            elements : this.elements,
            frames   : this.frames,
            focus    : this.focus,
            capture  : this.capture,
            dialogs  : this.dialogs,
            mock     : this.mock,
            emulation: this.emulation,
            upload   : this.upload,
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
