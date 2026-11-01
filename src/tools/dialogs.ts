import { z } from "zod";
import type { DaemonAccess } from "../mcp/index.js";
import { describeError, logDaemon } from "../daemon/log.js";
import { ErrorCode, RpcError } from "../daemon/index.js";
import type { ToolClock } from "./define-tool.js";
import { ToolError } from "./errors.js";

export const DIALOG_EVENTS = [
    "Page.javascriptDialogOpening",
    "Page.javascriptDialogClosed",
] as const;

export const DIALOG_MESSAGE_CLIP = 2000;

export const DIALOG_HISTORY_MESSAGE_CLIP = 200;

export const DIALOG_HISTORY_LIMIT = 50;

export type DialogPolicy = "none" | "accept" | "dismiss";

export type DialogResolution = "accept" | "dismiss" | "policy" | "closed";

export interface OpenDialog {
    type             : string;
    message          : string;
    defaultPrompt?   : string;
    url              : string;
    hasBrowserHandler: boolean;
}

export interface DialogHistoryEntry {
    type    : string;
    message : string;
    url     : string;
    resolved: DialogResolution;
    at      : string;
}

interface TabDialogs {
    pageEnabled: boolean;
    subscribed : Set<string>;
    open       : OpenDialog | undefined;
    policy     : DialogPolicy;
    history    : DialogHistoryEntry[];
}

export interface DialogStateOptions {
    access: DaemonAccess;
    clock : ToolClock;
}

export interface DialogResolveResult {
    handled: boolean;
    stale  : boolean;
}

const openingSchema = z.object({
    url              : z.string().optional(),
    message          : z.string().optional(),
    type             : z.string().optional(),
    hasBrowserHandler: z.boolean().optional(),
    defaultPrompt    : z.string().optional(),
});

function clip(text: string, limit: number): string {
    return [...text].length > limit ? `${[...text].slice(0, limit).join("")}...` : text;
}

function parseEnvelope(value: unknown): {
    targetId: string;
    event   : string;
    params  : unknown;
} | undefined {
    const envelope = value as {
        targetId?: unknown;
        event?   : unknown;
        params?  : unknown;
    } | null;

    if (typeof envelope?.targetId !== "string") return undefined;
    if (typeof envelope.event !== "string") return undefined;

    return { targetId: envelope.targetId, event: envelope.event, params: envelope.params };
}

export function assertNoDialog(dialogs: DialogState, tab: string): void {
    const open = dialogs.open(tab);

    if (open === undefined) return;

    throw new ToolError(
        `A ${open.type} dialog is open in this tab and blocks page scripts. ` +
        "Use page_dialogs to see it and accept or dismiss it first.",
    );
}

export class DialogState {
    private readonly access: DaemonAccess;
    private readonly clock : ToolClock;
    private readonly tabs = new Map<string, TabDialogs>();
    private attached = false;

    constructor(options: DialogStateOptions) {
        this.access = options.access;
        this.clock = options.clock;
    }

    attach(): void {
        if (this.attached) return;

        this.attached = true;
        this.access.on("cdp.event", (params) => this.handleCdpEvent(params));
        this.access.on("tab.closed", (params) => {
            const targetId = (params as { targetId?: unknown } | null)?.targetId;

            if (typeof targetId === "string") this.forget(targetId);
        });
    }

    pageEnabled(tab: string): boolean {
        return this.tabs.get(tab)?.pageEnabled ?? false;
    }

    async ensure(tab: string): Promise<void> {
        const state = this.state(tab);

        if (!state.pageEnabled) {
            await this.access.send(tab, "Page.enable", {});
            state.pageEnabled = true;
        }

        for (const event of DIALOG_EVENTS) {
            if (state.subscribed.has(event)) continue;

            await this.access.subscribe(tab, event);
            state.subscribed.add(event);
        }
    }

    open(tab: string): OpenDialog | undefined {
        const found = this.tabs.get(tab)?.open;

        return found === undefined ? undefined : { ...found };
    }

    policyOf(tab: string): DialogPolicy {
        return this.tabs.get(tab)?.policy ?? "none";
    }

    setPolicy(tab: string, policy: DialogPolicy): void {
        this.state(tab).policy = policy;
    }

    historyOf(tab: string): DialogHistoryEntry[] {
        return (this.tabs.get(tab)?.history ?? []).map((entry) => ({ ...entry }));
    }

    navigated(tab: string): void {
        const state = this.tabs.get(tab);

        if (state?.open === undefined) return;

        this.record(state, state.open, "closed");
        state.open = undefined;
    }

    async resolve(
        tab       : string,
        accept    : boolean,
        promptText: string | undefined,
    ): Promise<DialogResolveResult> {
        const state = this.state(tab);
        const open = state.open;

        if (open === undefined) return { handled: false, stale: false };

        try {
            await this.access.send(tab, "Page.handleJavaScriptDialog", {
                accept,
                ...(promptText === undefined ? {} : { promptText }),
            });
        } catch (error) {
            // The dialog went away on its own; the stale record must not block script tools.
            if (error instanceof RpcError && error.code === ErrorCode.cdpError) {
                this.record(state, open, "closed");
                state.open = undefined;

                return { handled: false, stale: true };
            }

            throw error;
        }

        this.record(state, open, accept ? "accept" : "dismiss");
        state.open = undefined;

        return { handled: true, stale: false };
    }

    forget(tab: string): void {
        this.tabs.delete(tab);
    }

    reset(): void {
        this.tabs.clear();
    }

    handleCdpEvent(params: unknown): void {
        const envelope = parseEnvelope(params);

        if (envelope === undefined) return;

        if (envelope.event === "Page.javascriptDialogOpening") {
            this.onOpening(envelope.targetId, envelope.params);

            return;
        }

        if (envelope.event === "Page.javascriptDialogClosed") {
            const state = this.tabs.get(envelope.targetId);

            if (state?.open === undefined) return;

            this.record(state, state.open, "closed");
            state.open = undefined;
        }
    }

    private onOpening(tab: string, params: unknown): void {
        const parsed = openingSchema.safeParse(params);

        if (!parsed.success) return;

        const state = this.state(tab);
        const dialog: OpenDialog = {
            type   : parsed.data.type ?? "alert",
            message: clip(parsed.data.message ?? "", DIALOG_MESSAGE_CLIP),
            ...(parsed.data.defaultPrompt === undefined || parsed.data.defaultPrompt === ""
                ? {}
                : { defaultPrompt: clip(parsed.data.defaultPrompt, DIALOG_MESSAGE_CLIP) }),
            url              : parsed.data.url ?? "",
            hasBrowserHandler: parsed.data.hasBrowserHandler ?? false,
        };

        state.open = dialog;

        if (state.policy === "none") return;

        const accept = state.policy === "accept";

        void this.access.send(tab, "Page.handleJavaScriptDialog", { accept })
            .then(() => {
                if (state.open !== dialog) return;

                this.record(state, dialog, "policy");
                state.open = undefined;
            })
            .catch((error: unknown) => {
                logDaemon(`could not resolve a dialog by policy: ${describeError(error)}`);
            });
    }

    private record(state: TabDialogs, dialog: OpenDialog, resolved: DialogResolution): void {
        state.history.push({
            type   : dialog.type,
            message: clip(dialog.message, DIALOG_HISTORY_MESSAGE_CLIP),
            url    : dialog.url,
            resolved,
            at     : new Date(this.clock.now()).toISOString(),
        });

        while (state.history.length > DIALOG_HISTORY_LIMIT) state.history.shift();
    }

    private state(tab: string): TabDialogs {
        let state = this.tabs.get(tab);

        if (!state) {
            state = {
                pageEnabled: false,
                subscribed : new Set(),
                open       : undefined,
                policy     : "none",
                history    : [],
            };
            this.tabs.set(tab, state);
        }

        return state;
    }
}
