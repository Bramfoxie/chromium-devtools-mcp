import { z } from "zod";
import { describeError, logDaemon, quoted } from "../daemon/log.js";
import type { DaemonLink } from "./daemon-link.js";

export class SessionResetError extends Error {
    constructor() {
        super("The browser session was restarted and its tabs are gone. Open a new tab with new_tab.");
        this.name = "SessionResetError";
    }
}

const tabSchema = z.strictObject({
    targetId: z.string(),
    url     : z.string(),
    title   : z.string(),
    owned   : z.boolean(),
    created : z.boolean(),
});

export type DaemonTab = z.infer<typeof tabSchema>;

const tabListSchema = z.strictObject({ tabs: z.array(tabSchema) });

const createdSchema = z.strictObject({ targetId: z.string() });

const sessionSummarySchema = z.strictObject({
    sessionId : z.string(),
    clientName: z.string(),
    isolated  : z.boolean(),
    tabs      : z.number(),
    own       : z.boolean(),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

const sessionListSchema = z.strictObject({ sessions: z.array(sessionSummarySchema) });

function parse<T>(label: string, schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);

    if (result.success) return result.data;

    throw new Error(`The daemon answered ${label} with an unexpected result. Update both sides to the same version.`);
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

        void this.attach(registration);

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

    async send(
        targetId  : string,
        method    : string,
        params?   : Record<string, unknown>,
        timeoutMs?: number,
    ): Promise<unknown> {
        return this.request("cdp.send", {
            targetId,
            method,
            ...(params === undefined ? {} : { params }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
    }

    async subscribe(targetId: string, event: string): Promise<void> {
        await this.request("cdp.subscribe", { targetId, event });
    }

    async unsubscribe(targetId: string, event: string): Promise<void> {
        await this.request("cdp.unsubscribe", { targetId, event });
    }

    assertCurrent(generation: number): void {
        if (generation === this.generation) return;

        throw new SessionResetError();
    }

    private async request(method: string, params: unknown): Promise<unknown> {
        this.syncGeneration();

        return this.link.request(method, params);
    }

    private syncGeneration(): void {
        if (this.link.sessionGeneration === this.generation) return;

        this.generation = this.link.sessionGeneration;
        this.attachAll();
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
            // No daemon yet: attachAll retries on the next session generation.
        }
    }
}
