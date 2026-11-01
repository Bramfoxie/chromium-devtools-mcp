import type { DaemonAccess } from "../../mcp/index.js";
import { describeError, logDaemon } from "../../daemon/log.js";
import type { ToolClock } from "../define-tool.js";

export const FETCH_EVENT = "Fetch.requestPaused";

export const MOCK_URL_PATTERN_MAX_CHARS = 1024;

export const MOCK_RULES_MAX = 100;

export const MOCK_HEADER_NAME_MAX_CHARS = 256;

export const MOCK_HEADER_VALUE_MAX_CHARS = 8192;

export const MOCK_HEADERS_MAX = 50;

export const MOCK_BODY_MAX_BYTES = 10 * 1024 * 1024;

export const MOCK_DELAY_MAX_MS = 30_000;

export type FailReason =
    | "Failed"
    | "Aborted"
    | "TimedOut"
    | "AccessDenied"
    | "ConnectionClosed"
    | "ConnectionReset"
    | "ConnectionRefused"
    | "ConnectionAborted"
    | "ConnectionFailed"
    | "NameNotResolved"
    | "InternetDisconnected"
    | "AddressUnreachable"
    | "BlockedByClient"
    | "BlockedByResponse";

export interface MockResponse {
    status     : number;
    headers    : Array<{ name: string; value: string }>;
    bodyBase64 : string | undefined;
    contentType: string | undefined;
}

export interface MockAction {
    response: MockResponse | undefined;
    fail    : FailReason | undefined;
    delayMs : number;
    times   : number | undefined;
}

export interface MockRule extends MockAction {
    id          : string;
    urlPattern  : string;
    method      : string | undefined;
    resourceType: string | undefined;
    applications: number;
    createdAt   : string;
}

export interface RuleInput extends MockAction {
    urlPattern  : string;
    method      : string | undefined;
    resourceType: string | undefined;
}

interface TabInterception {
    enabled   : boolean;
    enableSent: boolean;
    subscribed: boolean;
    counter   : number;
    rules     : MockRule[];
    pending   : Map<string, NodeJS.Timeout>;
}

export interface InterceptionOptions {
    access: DaemonAccess;
    clock : ToolClock;
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

interface PausedRequest {
    requestId   : string;
    request     : { url: string; method: string };
    resourceType: string;
}

function pausedOf(params: unknown): PausedRequest | undefined {
    const parsed = params as {
        requestId?   : unknown;
        request?     : { url?: unknown; method?: unknown } | null;
        resourceType?: unknown;
    } | null;

    if (typeof parsed?.requestId !== "string") return undefined;
    if (typeof parsed.request?.url !== "string") return undefined;
    if (typeof parsed.request.method !== "string") return undefined;
    if (typeof parsed.resourceType !== "string") return undefined;

    return {
        requestId   : parsed.requestId,
        request     : { url: parsed.request.url, method: parsed.request.method },
        resourceType: parsed.resourceType,
    };
}

export function matchWildcard(pattern: string, value: string): boolean {
    let regex = "^";

    for (const char of pattern) {
        if (char === "*") {
            regex += ".*";
        } else if (char === "?") {
            regex += ".";
        } else {
            regex += char.replace(/[.+^${}()|[\]\\]/, "\\$&");
        }
    }

    regex += "$";

    try {
        return new RegExp(regex).test(value);
    } catch {
        return false;
    }
}

export function ruleMatches(
    rule        : MockRule,
    url         : string,
    method      : string,
    resourceType: string,
): boolean {
    if (!matchWildcard(rule.urlPattern, url)) return false;

    if (rule.method !== undefined && rule.method.toUpperCase() !== method.toUpperCase()) {
        return false;
    }

    if (rule.resourceType !== undefined && rule.resourceType !== resourceType) return false;
    if (rule.times !== undefined && rule.applications >= rule.times) return false;

    return true;
}

export function headersForCdp(response: MockResponse): Array<{ name: string; value: string }> {
    const headers = response.headers.map((header) => ({ ...header }));

    if (response.contentType !== undefined) {
        const hasContentType = headers.some((header) => header.name.toLowerCase() === "content-type");

        if (!hasContentType) headers.push({ name: "content-type", value: response.contentType });
    }

    return headers;
}

export class InterceptionManager {
    private readonly access: DaemonAccess;
    private readonly clock : ToolClock;
    private readonly tabs = new Map<string, TabInterception>();
    private attached = false;

    constructor(options: InterceptionOptions) {
        this.access = options.access;
        this.clock = options.clock;
    }

    attach(): void {
        if (this.attached) return;

        this.attached = true;
        this.access.on("cdp.event", (params) => void this.handleCdpEvent(params));
        this.access.on("tab.closed", (params) => {
            const targetId = (params as { targetId?: unknown } | null)?.targetId;

            if (typeof targetId === "string") void this.forget(targetId);
        });
    }

    enabled(tab: string): boolean {
        return this.tabs.get(tab)?.enabled ?? false;
    }

    rulesOf(tab: string): MockRule[] {
        return (this.tabs.get(tab)?.rules ?? []).map((rule) => ({
            ...rule,
            response: rule.response === undefined ? undefined : {
                ...rule.response,
                headers: rule.response.headers.map((header) => ({ ...header })),
            },
        }));
    }

    add(tab: string, input: RuleInput): MockRule {
        const state = this.state(tab);

        state.counter += 1;

        const rule: MockRule = {
            ...input,
            id          : `mock${state.counter}`,
            applications: 0,
            createdAt   : new Date(this.clock.now()).toISOString(),
        };

        state.rules.push(rule);

        return {
            ...rule,
            response: rule.response === undefined ? undefined : {
                ...rule.response,
                headers: rule.response.headers.map((header) => ({ ...header })),
            },
        };
    }

    remove(tab: string, id: string): MockRule | undefined {
        const state = this.tabs.get(tab);

        if (state === undefined) return undefined;

        const index = state.rules.findIndex((rule) => rule.id === id);

        if (index === -1) return undefined;

        const [removed] = state.rules.splice(index, 1);

        return removed === undefined ? undefined : { ...removed };
    }

    clear(tab: string): number {
        const state = this.tabs.get(tab);

        if (state === undefined) return 0;

        const count = state.rules.length;

        state.rules = [];

        return count;
    }

    async sync(tab: string): Promise<void> {
        const state = this.tabs.get(tab);

        if (state === undefined || state.rules.length === 0) {
            await this.disable(tab);

            return;
        }

        await this.enable(tab, state);
    }

    async handlePaused(
        tab    : string,
        paused : PausedRequest,
        resolve: (command: () => Promise<unknown>) => Promise<void>,
    ): Promise<void> {
        const state = this.tabs.get(tab);
        const rule = state?.rules.find((candidate) =>
            ruleMatches(candidate, paused.request.url, paused.request.method, paused.resourceType),
        );

        if (rule === undefined || state === undefined) {
            await resolve(() => this.access.send(tab, "Fetch.continueRequest", {
                requestId: paused.requestId,
            }));

            return;
        }

        rule.applications += 1;

        const expired = rule.times !== undefined && rule.applications >= rule.times;

        if (rule.delayMs > 0) await this.clock.sleep(rule.delayMs);

        if (rule.response !== undefined) {
            const body = rule.response.bodyBase64;

            await resolve(() => this.access.send(tab, "Fetch.fulfillRequest", {
                requestId      : paused.requestId,
                responseCode   : rule.response?.status ?? 200,
                responseHeaders: headersForCdp(rule.response as MockResponse),
                ...(body === undefined ? {} : { body }),
            }));
        } else {
            await resolve(() => this.access.send(tab, "Fetch.failRequest", {
                requestId  : paused.requestId,
                errorReason: rule.fail ?? "Failed",
            }));
        }

        if (expired) {
            state.rules = state.rules.filter((candidate) => candidate !== rule);
            await this.sync(tab).catch((error: unknown) => {
                logDaemon(`could not sync interception: ${describeError(error)}`);
            });
        }
    }

    async forget(tab: string): Promise<void> {
        const state = this.tabs.get(tab);

        this.tabs.delete(tab);

        if (state === undefined || !state.enableSent) return;

        for (const timer of state.pending.values()) clearTimeout(timer);

        await this.access.send(tab, "Fetch.disable", {}).catch(() => undefined);
    }

    async reset(): Promise<void> {
        const tabs = [...this.tabs.keys()];

        for (const tab of tabs) await this.forget(tab);
    }

    handleCdpEvent(params: unknown): Promise<void> {
        const envelope = parseEnvelope(params);

        if (envelope === undefined || envelope.event !== FETCH_EVENT) return Promise.resolve();

        const paused = pausedOf(envelope.params);

        if (paused === undefined) return Promise.resolve();

        return this.handlePaused(envelope.targetId, paused, async (command) => {
            try {
                await command();
            } catch (error) {
                logDaemon(`could not resolve a paused request: ${describeError(error)}`);

                await this.access.send(envelope.targetId, "Fetch.continueRequest", {
                    requestId: paused.requestId,
                }).catch((nested: unknown) => {
                    logDaemon(`could not continue a paused request: ${describeError(nested)}`);
                });
            }
        }).catch((error: unknown) => {
            logDaemon(`mock handler failed: ${describeError(error)}`);

            return this.access.send(envelope.targetId, "Fetch.continueRequest", {
                requestId: paused.requestId,
            }).then(() => undefined).catch(() => undefined);
        });
    }

    private async enable(tab: string, state: TabInterception): Promise<void> {
        const patterns = state.rules.map((rule) => ({ urlPattern: rule.urlPattern }));

        await this.access.send(tab, "Fetch.enable", { patterns });
        state.enableSent = true;

        if (!state.subscribed) {
            await this.access.subscribe(tab, FETCH_EVENT);
            state.subscribed = true;
        }

        state.enabled = true;
    }

    private async disable(tab: string): Promise<void> {
        const state = this.tabs.get(tab);

        if (state === undefined) return;

        state.enabled = false;

        if (!state.enableSent) return;

        state.enableSent = false;

        await this.access.send(tab, "Fetch.disable", {}).catch(() => undefined);
    }

    private state(tab: string): TabInterception {
        let state = this.tabs.get(tab);

        if (!state) {
            state = {
                enabled   : false,
                enableSent: false,
                subscribed: false,
                counter   : 0,
                rules     : [],
                pending   : new Map(),
            };
            this.tabs.set(tab, state);
        }

        return state;
    }
}
