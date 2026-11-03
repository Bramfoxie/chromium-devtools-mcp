import { parseEnvelope } from "../cdp-envelope.js";
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

export const MOCK_TOTAL_BODY_MAX_BYTES = 64 * 1024 * 1024;

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
    errors      : number;
    createdAt   : string;
}

export interface RuleInput extends MockAction {
    urlPattern  : string;
    method      : string | undefined;
    resourceType: string | undefined;
}

interface DeferredRequest {
    ruleId  : string;
    released: boolean;
    release : () => void;
}

interface TabInterception {
    enabled   : boolean;
    enableSent: boolean;
    subscribed: boolean;
    counter   : number;
    rules     : MockRule[];
    deferred  : Map<string, DeferredRequest>;
}

export interface InterceptionOptions {
    access: DaemonAccess;
    clock : ToolClock;
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

type PatternToken = { kind: "star" } | { kind: "any" } | { kind: "char"; value: string };

function tokenize(pattern: string): PatternToken[] {
    const tokens: PatternToken[] = [];

    for (let index = 0; index < pattern.length; index += 1) {
        const char = pattern[index] as string;

        if (char === "\\" && index + 1 < pattern.length) {
            index += 1;
            tokens.push({ kind: "char", value: pattern[index] as string });
        } else if (char === "*") {
            tokens.push({ kind: "star" });
        } else if (char === "?") {
            tokens.push({ kind: "any" });
        } else {
            tokens.push({ kind: "char", value: char });
        }
    }

    return tokens;
}

export function matchWildcard(pattern: string, value: string): boolean {
    const tokens = tokenize(pattern);
    let pi = 0;
    let vi = 0;
    let star = -1;
    let mark = 0;

    while (vi < value.length) {
        const token = tokens[pi];

        if (token !== undefined && (token.kind === "any" || (token.kind === "char" && token.value === value[vi]))) {
            pi += 1;
            vi += 1;
        } else if (token?.kind === "star") {
            star = pi;
            mark = vi;
            pi += 1;
        } else if (star !== -1) {
            mark += 1;
            vi = mark;
            pi = star + 1;
        } else {
            return false;
        }
    }

    while (tokens[pi]?.kind === "star") pi += 1;

    return pi === tokens.length;
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
    if (rule.times !== undefined && rule.applications - rule.errors >= rule.times) return false;

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
    private readonly pending = new Map<MockRule, number>();
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

    bodyBytes(): number {
        let total = 0;

        for (const state of this.tabs.values()) {
            for (const rule of state.rules) {
                total += Buffer.from(rule.response?.bodyBase64 ?? "", "base64").length;
            }
        }

        return total;
    }

    enabled(tab: string): boolean {
        return this.tabs.get(tab)?.enabled ?? false;
    }

    rulesOf(tab: string): MockRule[] {
        return (this.tabs.get(tab)?.rules ?? []).map(copyRule);
    }

    add(tab: string, input: RuleInput): MockRule {
        const state = this.state(tab);

        state.counter += 1;

        const rule: MockRule = {
            ...input,
            id          : `mock${state.counter}`,
            applications: 0,
            errors      : 0,
            createdAt   : new Date(this.clock.now()).toISOString(),
        };

        state.rules.push(rule);

        return copyRule(rule);
    }

    remove(tab: string, id: string): MockRule | undefined {
        const state = this.tabs.get(tab);

        if (state === undefined) return undefined;

        const index = state.rules.findIndex((rule) => rule.id === id);

        if (index === -1) return undefined;

        const [removed] = state.rules.splice(index, 1);

        void this.releaseDeferred(tab, state, id);

        return removed === undefined ? undefined : { ...removed };
    }

    clear(tab: string): number {
        const state = this.tabs.get(tab);

        if (state === undefined) return 0;

        const count = state.rules.length;

        state.rules = [];
        void this.releaseDeferred(tab, state);

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
        resolve: (command: () => Promise<unknown>) => Promise<boolean>,
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
        this.pending.set(rule, (this.pending.get(rule) ?? 0) + 1);

        try {
            await this.applyRule(tab, state, rule, paused, resolve);
        } finally {
            await this.settle(tab, state, rule);
        }
    }

    private async settle(tab: string, state: TabInterception, rule: MockRule): Promise<void> {
        const remaining = (this.pending.get(rule) ?? 1) - 1;

        if (remaining > 0) {
            this.pending.set(rule, remaining);

            return;
        }

        this.pending.delete(rule);

        const exhausted = rule.times !== undefined && rule.applications - rule.errors >= rule.times;

        if (!exhausted || !state.rules.includes(rule)) return;

        state.rules = state.rules.filter((candidate) => candidate !== rule);
        await this.sync(tab).catch((error: unknown) => {
            logDaemon(`could not sync interception: ${describeError(error)}`);
        });
    }

    private async applyRule(
        tab    : string,
        state  : TabInterception,
        rule   : MockRule,
        paused : PausedRequest,
        resolve: (command: () => Promise<unknown>) => Promise<boolean>,
    ): Promise<void> {
        if (rule.delayMs > 0) {
            let wake: () => void = () => undefined;
            const entry: DeferredRequest = {
                ruleId  : rule.id,
                released: false,
                release : () => {
                    entry.released = true;
                    wake();
                },
            };
            const woken = new Promise<void>((resolveWake) => {
                wake = resolveWake;
            });

            state.deferred.set(paused.requestId, entry);
            await Promise.race([this.clock.sleep(rule.delayMs), woken]);

            if (entry.released) {
                rule.errors += 1;

                return;
            }

            state.deferred.delete(paused.requestId);
        }

        let resolved: boolean;

        if (rule.response !== undefined) {
            const body = rule.response.bodyBase64;

            resolved = await resolve(() => this.access.send(tab, "Fetch.fulfillRequest", {
                requestId      : paused.requestId,
                responseCode   : rule.response?.status ?? 200,
                responseHeaders: headersForCdp(rule.response as MockResponse),
                ...(body === undefined ? {} : { body }),
            }));
        } else {
            resolved = await resolve(() => this.access.send(tab, "Fetch.failRequest", {
                requestId  : paused.requestId,
                errorReason: rule.fail ?? "Failed",
            }));
        }

        if (!resolved) rule.errors += 1;
    }

    async forget(tab: string): Promise<void> {
        const state = this.tabs.get(tab);

        this.tabs.delete(tab);

        if (state === undefined) return;

        await this.releaseDeferred(tab, state);

        if (!state.enableSent) return;

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

                return true;
            } catch (error) {
                logDaemon(`could not resolve a paused request: ${describeError(error)}`);

                await this.access.send(envelope.targetId, "Fetch.continueRequest", {
                    requestId: paused.requestId,
                }).catch((nested: unknown) => {
                    logDaemon(`could not continue a paused request: ${describeError(nested)}`);
                });

                return false;
            }
        }).catch((error: unknown) => {
            logDaemon(`mock handler failed: ${describeError(error)}`);

            return this.access.send(envelope.targetId, "Fetch.continueRequest", {
                requestId: paused.requestId,
            }).then(() => undefined).catch(() => undefined);
        });
    }

    private async enable(tab: string, state: TabInterception): Promise<void> {
        if (!state.subscribed) {
            await this.access.subscribe(tab, FETCH_EVENT);
            state.subscribed = true;
        }

        try {
            const patterns = state.rules.map((rule) => ({
                urlPattern: rule.urlPattern,
                ...(rule.resourceType === undefined ? {} : { resourceType: rule.resourceType }),
            }));

            await this.access.send(tab, "Fetch.enable", { patterns });
            state.enableSent = true;
            state.enabled = true;
        } catch (error) {
            await this.access.unsubscribe(tab, FETCH_EVENT).catch(() => undefined);
            state.subscribed = false;

            throw error;
        }
    }

    private async releaseDeferred(
        tab    : string,
        state  : TabInterception,
        ruleId?: string,
    ): Promise<void> {
        const entries = [...state.deferred.entries()].filter(
            ([, entry]) => ruleId === undefined || entry.ruleId === ruleId,
        );

        for (const [requestId] of entries) state.deferred.delete(requestId);

        await Promise.all(entries.map(async ([requestId, entry]) => {
            entry.release();
            await this.access.send(tab, "Fetch.continueRequest", { requestId }).catch(() => undefined);
        }));
    }

    private async disable(tab: string): Promise<void> {
        const state = this.tabs.get(tab);

        if (state === undefined) return;

        state.enabled = false;
        await this.releaseDeferred(tab, state);

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
                deferred  : new Map(),
            };
            this.tabs.set(tab, state);
        }

        return state;
    }
}

function copyRule(rule: MockRule): MockRule {
    return {
        ...rule,
        response: rule.response === undefined ? undefined : {
            ...rule.response,
            headers: rule.response.headers.map((header) => ({ ...header })),
        },
    };
}
