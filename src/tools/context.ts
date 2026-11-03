import type { Config } from "../config/index.js";
import type { DaemonAccess, DaemonTab } from "../mcp/index.js";
import { confirmedAccess, type Confirmer } from "./confirmation.js";
import { CaptureManager } from "./capture/manager.js";
import type { KnownTab, ToolClock, ToolContext } from "./define-tool.js";
import { DialogState } from "./dialogs.js";
import { ElementRegistry } from "./element-target.js";
import { type ArtifactStore, noArtifacts } from "./artifacts.js";
import { WebAuthnState } from "./webauthn-state.js";
import { ScreencastRecorder } from "./perf/screencast-recorder.js";
import { findBrowserExecutable } from "../browser/discovery.js";
import { TraceRecorder } from "./perf/trace-recorder.js";
import { type LighthouseTools, nodeLighthouseTools } from "./perf/lighthouse-tools.js";
import { nodeVideoTools, type VideoTools } from "./perf/video.js";
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
    access     : DaemonAccess;
    config     : Config;
    clock?     : ToolClock;
    tabs?      : SessionTabs;
    elements?  : ElementRegistry;
    frames?    : FrameState;
    focus?     : FocusEmulation;
    capture?   : CaptureManager;
    dialogs?   : DialogState;
    mock?      : InterceptionManager;
    emulation? : EmulationState;
    upload?    : UploadEnvironment;
    artifacts? : ArtifactStore;
    video?     : VideoTools;
    lighthouse?: LighthouseTools;
    confirm?   : Confirmer;
}

export class ToolRuntime {
    readonly access    : DaemonAccess;
    readonly config    : Config;
    readonly clock     : ToolClock;
    readonly tabs      : SessionTabs;
    readonly elements  : ElementRegistry;
    readonly frames    : FrameState;
    readonly focus     : FocusEmulation;
    readonly capture   : CaptureManager;
    readonly dialogs   : DialogState;
    readonly mock      : InterceptionManager;
    readonly emulation : EmulationState;
    readonly upload    : UploadEnvironment;
    readonly trace     : TraceRecorder;
    readonly screencast: ScreencastRecorder;
    readonly video     : VideoTools;
    readonly lighthouse: LighthouseTools;
    readonly webauthn  : WebAuthnState;
    readonly artifacts : ArtifactStore;
    readonly confirm   : Confirmer | undefined;

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
        this.artifacts = options.artifacts ?? noArtifacts;
        this.trace = new TraceRecorder(options.access, this.clock);
        this.screencast = new ScreencastRecorder(options.access, this.clock);
        this.webauthn = new WebAuthnState();
        this.video = options.video ?? nodeVideoTools(process.env, process.platform);
        this.lighthouse = options.lighthouse ??
            nodeLighthouseTools(process.env, process.platform, () => {
                try {
                    return findBrowserExecutable(options.config.browser);
                } catch {
                    return undefined;
                }
            });
        this.confirm = options.confirm;
    }

    attach(): void {
        this.access.on("tab.closed", (params) => {
            const targetId = (params as { targetId?: unknown } | null)?.targetId;

            if (typeof targetId === "string") void this.forgetTab(targetId);
        });
        this.capture.attach();
        this.dialogs.attach();
        this.frames.attach();
        this.mock.attach();
        this.trace.attach();
        this.screencast.attach();
        this.access.forgetStaleState(() => void this.resetAll());
    }

    async forgetTab(targetId: string): Promise<void> {
        this.tabs.forget(targetId);
        this.elements.forget(targetId);
        this.frames.forget(targetId);
        this.focus.forget(targetId);
        this.capture.forget(targetId);
        this.dialogs.forget(targetId);
        const mock = this.mock.forget(targetId);
        const trace = this.trace.forget(targetId);
        const screencast = this.screencast.forget(targetId);

        this.webauthn.forget(targetId);
        const origin = this.emulation.snapshot(targetId).geolocation?.origin;

        this.emulation.forget(targetId);
        await mock;
        await trace;
        await screencast;

        if (origin !== undefined && !this.emulation.geolocationOrigins().has(origin)) {
            await this.access
                .setPermission({ name: "geolocation", setting: "reset", origin })
                .catch(() => undefined);
        }
    }

    async resetAll(): Promise<void> {
        this.tabs.reset();
        this.elements.reset();
        this.frames.reset();
        this.focus.reset();
        this.capture.reset();
        this.dialogs.reset();
        const mock = this.mock.reset();
        const trace = this.trace.reset();
        const screencast = this.screencast.reset();

        this.webauthn.reset();

        this.emulation.reset();
        await mock;
        await trace;
        await screencast;
    }

    context(signal: AbortSignal, confirmed = false): ToolContext {
        const tabs = this.tabs;

        return {
            access    : confirmed ? confirmedAccess(this.access) : this.access,
            tabs,
            elements  : this.elements,
            frames    : this.frames,
            focus     : this.focus,
            capture   : this.capture,
            dialogs   : this.dialogs,
            mock      : this.mock,
            emulation : this.emulation,
            upload    : this.upload,
            trace     : this.trace,
            screencast: this.screencast,
            video     : this.video,
            lighthouse: this.lighthouse,
            webauthn  : this.webauthn,
            artifacts : this.artifacts,
            config    : this.config,
            clock     : this.clock,
            signal,
            forgetTab : (targetId) => this.forgetTab(targetId),
            state     : {
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
