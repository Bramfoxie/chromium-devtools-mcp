import type { Config } from "../config/index.js";
import type { DaemonAccess, DaemonTab } from "../mcp/index.js";
import type { ToolClock, ToolContext } from "./define-tool.js";

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
    access: DaemonAccess;
    config: Config;
    clock?: ToolClock;
    tabs? : SessionTabs;
}

export class ToolRuntime {
    readonly access: DaemonAccess;
    readonly config: Config;
    readonly clock : ToolClock;
    readonly tabs  : SessionTabs;

    constructor(options: ToolRuntimeOptions) {
        this.access = options.access;
        this.config = options.config;
        this.clock = options.clock ?? {
            now  : () => Date.now(),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        };
        this.tabs = options.tabs ?? new SessionTabs();
    }

    context(signal: AbortSignal): ToolContext {
        const tabs = this.tabs;

        return {
            access: this.access,
            tabs,
            config: this.config,
            clock : this.clock,
            signal,
            state : {
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
