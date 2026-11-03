import { z } from "zod";
import {
    createdSchema,
    frameListSchema,
    sessionListSchema,
    tabListSchema,
    type FrameSummary,
    type SessionSummary,
    type TabInfo,
} from "../daemon/index.js";
import { describeError, logDaemon, quoted } from "../util/log.js";
import type { DaemonLink } from "./daemon-link.js";
import { AppError } from "../util/app-error.js";

export type DaemonTab = TabInfo;

export type DaemonFrame = FrameSummary;

export type { SessionSummary };

export class SessionResetError extends AppError {
    constructor() {
        super("The browser session was restarted and its tabs are gone. Open a new tab with new_tab.");
    }
}

function parse<T>(label: string, schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);

    if (result.success) return result.data;

    throw new Error(`The daemon answered ${label} with an unexpected result. Update both sides to the same version.`);
}

export interface CdpCommand {
    targetId  : string;
    method    : string;
    params?   : Record<string, unknown>;
    timeoutMs?: number;
    frameId?  : string;
    signal?   : AbortSignal;
    confirmed?: boolean;
}

export type DaemonEventHandler = (params: unknown) => void;

interface EventRegistration {
    event  : string;
    handler: DaemonEventHandler;
    off    : () => void;
}

export interface DaemonAccessOptions {
    link: DaemonLink;
}

export class DaemonAccess {
    private readonly link         : DaemonLink;
    private readonly registrations: EventRegistration[] = [];
    private generation            : number;
    private attachedClient        : object | undefined;

    constructor(options: DaemonAccessOptions) {
        this.link = options.link;
        this.generation = options.link.sessionGeneration;
    }

    get sessionGeneration(): number {
        return this.generation;
    }

    on(event: string, handler: DaemonEventHandler): () => void {
        const registration: EventRegistration = { event, handler, off: () => undefined };

        this.registrations.push(registration);

        if (this.attachedClient !== undefined) void this.attach(registration);

        return () => {
            const index = this.registrations.indexOf(registration);

            if (index === -1) return;

            this.registrations.splice(index, 1);
            registration.off();
            registration.off = () => undefined;
        };
    }

    onSessionReset(handler: () => void): () => void {
        return this.link.onSessionReset(handler);
    }

    forgetStaleState(onReset: () => void): () => void {
        return this.link.onSessionReset(() => {
            this.generation += 1;
            this.attachAll();
            onReset();
        });
    }

    async createTab(url?: string): Promise<string> {
        const result = await this.request("tab.create", url === undefined ? {} : { url });

        return parse("tab.create", createdSchema, result).targetId;
    }

    async listTabs(scope: "owned" | "available"): Promise<DaemonTab[]> {
        const result = await this.request("tab.list", { scope });

        return parse("tab.list", tabListSchema, result).tabs;
    }

    async claimTab(targetId: string): Promise<void> {
        await this.request("tab.claim", { targetId });
    }

    async closeTab(targetId: string): Promise<void> {
        await this.request("tab.close", { targetId });
    }

    async listSessions(): Promise<SessionSummary[]> {
        const result = await this.request("session.list", {});

        return parse("session.list", sessionListSchema, result).sessions;
    }

    async listFrames(targetId: string): Promise<DaemonFrame[]> {
        const result = await this.request("frame.list", { targetId });

        return parse("frame.list", frameListSchema, result).frames;
    }

    async send(command: CdpCommand): Promise<unknown> {
        const { targetId, method, params, timeoutMs, frameId, signal, confirmed } = command;

        return this.request(
            "cdp.send",
            {
                targetId,
                method,
                ...(confirmed === true ? { confirmed: true } : {}),
                ...(params === undefined ? {} : { params }),
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
                ...(frameId === undefined ? {} : { frameId }),
            },
            signal === undefined ? undefined : { signal },
        );
    }

    async subscribe(targetId: string, event: string, frameId?: string): Promise<void> {
        await this.request("cdp.subscribe", {
            targetId,
            event,
            ...(frameId === undefined ? {} : { frameId }),
        });
    }

    async unsubscribe(targetId: string, event: string, frameId?: string): Promise<void> {
        await this.request("cdp.unsubscribe", {
            targetId,
            event,
            ...(frameId === undefined ? {} : { frameId }),
        });
    }

    assertCurrent(generation: number): void {
        if (generation === this.generation) return;

        throw new SessionResetError();
    }

    private async request(
        method  : string,
        params  : unknown,
        options?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<unknown> {
        const result = await this.link.request(method, params, options);

        this.syncGeneration();
        void this.attachMissing();

        return result;
    }

    private syncGeneration(): void {
        if (this.link.sessionGeneration === this.generation) return;

        this.generation = this.link.sessionGeneration;
        this.attachedClient = undefined;
        this.attachAll();
    }

    private async attachMissing(): Promise<void> {
        try {
            const client = await this.link.ready();

            if (this.attachedClient === client) return;

            this.attachedClient = client;
            this.attachAll();
        } catch {
        }
    }

    private attachAll(): void {
        for (const registration of [...this.registrations]) void this.attach(registration);
    }

    private async attach(registration: EventRegistration): Promise<void> {
        try {
            const client = await this.link.ready();

            if (!this.registrations.includes(registration)) return;

            registration.off();
            registration.off = client.on(registration.event, (params) => {
                try {
                    registration.handler(params);
                } catch (error) {
                    logDaemon(
                        `a handler for ${quoted(registration.event)} threw: ${describeError(error)}`,
                    );
                }
            });
        } catch {
        }
    }
}
