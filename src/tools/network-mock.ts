import { z } from "zod";
import { defineTool } from "./define-tool.js";
import { ToolError } from "./errors.js";
import {
    MOCK_BODY_MAX_BYTES,
    MOCK_DELAY_MAX_MS,
    MOCK_HEADER_NAME_MAX_CHARS,
    MOCK_HEADER_VALUE_MAX_CHARS,
    MOCK_HEADERS_MAX,
    MOCK_RULES_MAX,
    MOCK_URL_PATTERN_MAX_CHARS,
    type FailReason,
    type InterceptionManager,
    type MockResponse,
    type RuleInput,
} from "./mock/interception.js";
import { throwIfCancelled } from "./registry.js";

export const MOCK_METHOD_MAX_CHARS = 32;

export const MOCK_RESOURCE_TYPE_MAX_CHARS = 64;

export const MOCK_TIMES_MAX = 1_000_000;

const BASE64_CHARS_MAX = Math.ceil(MOCK_BODY_MAX_BYTES / 3) * 4;

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

const failReasonSchema = z.enum([
    "Failed",
    "Aborted",
    "TimedOut",
    "AccessDenied",
    "ConnectionClosed",
    "ConnectionReset",
    "ConnectionRefused",
    "ConnectionAborted",
    "ConnectionFailed",
    "NameNotResolved",
    "InternetDisconnected",
    "AddressUnreachable",
    "BlockedByClient",
    "BlockedByResponse",
]);

const headerName = z.string()
    .min(1)
    .max(MOCK_HEADER_NAME_MAX_CHARS)
    .refine((name) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name), {
        message: "Header names must be valid HTTP tokens.",
    });

const headerValue = z.string()
    .max(MOCK_HEADER_VALUE_MAX_CHARS)
    .refine((value) => !/[\r\n\0]/.test(value), {
        message: "Header values must not contain CR, LF or NUL characters.",
    });

const responseSchema = z.strictObject({
    status     : z.number().int().min(200).max(599).describe("HTTP status of the mocked response, 200 to 599."),
    headers    : z.record(headerName, headerValue).optional().describe("Response headers, at most 50."),
    body       : z.string().max(MOCK_BODY_MAX_BYTES).optional().describe("Response body as text, mutually exclusive with bodyBase64."),
    bodyBase64 : z.string().max(BASE64_CHARS_MAX).optional().describe("Response body as base64, mutually exclusive with body."),
    contentType: z.string().min(1).max(256).optional().describe("Content type, added when no content-type header is given."),
});

const failSchema = z.strictObject({
    reason: failReasonSchema.describe("CDP Network.ErrorReason for the failure."),
});

const addSchema = z.strictObject({
    urlPattern  : z.string().min(1).max(MOCK_URL_PATTERN_MAX_CHARS).describe("Fetch wildcard pattern with * and ?."),
    method      : z.string().min(1).max(MOCK_METHOD_MAX_CHARS).optional().describe("HTTP method filter, case insensitive."),
    resourceType: z.string().min(1).max(MOCK_RESOURCE_TYPE_MAX_CHARS).optional().describe("CDP resource type filter."),
    response    : responseSchema.optional().describe("Mocked response, exactly one of response and fail."),
    fail        : failSchema.optional().describe("Network failure, exactly one of response and fail."),
    delayMs     : z.number().int().min(0).max(MOCK_DELAY_MAX_MS).optional().describe("Delay before resolving, 0 to 30000. Defaults to 0."),
    times       : z.number().int().min(1).max(MOCK_TIMES_MAX).optional().describe("Apply this many times, then expire."),
});

export type MockAddInput = z.infer<typeof addSchema>;

const ruleSchema = z.strictObject({
    id          : z.string().describe("Rule id."),
    urlPattern  : z.string().describe("Fetch wildcard pattern."),
    method      : z.string().optional().describe("HTTP method filter, when set."),
    resourceType: z.string().optional().describe("Resource type filter, when set."),
    kind        : z.enum(["response", "fail"]).describe("What the rule does."),
    status      : z.number().optional().describe("Mocked status, for response rules."),
    delayMs     : z.number().describe("Delay before resolving."),
    times       : z.number().optional().describe("Application limit, when set."),
    applications: z.number().describe("How many requests the rule resolved successfully."),
    errors      : z.number().describe("How many requests the rule claimed but could not resolve, so they went to the network."),
    createdAt   : z.string().describe("ISO time when the rule was added."),
});

function bodyTooLarge(): ToolError {
    return new ToolError(
        `The body is over the ${MOCK_BODY_MAX_BYTES} byte limit. Send a smaller body.`,
    );
}

export function ruleInputOf(args: MockAddInput): RuleInput {
    const hasResponse = args.response !== undefined;
    const hasFail = args.fail !== undefined;

    if (hasResponse === hasFail) {
        throw new ToolError("Provide exactly one of response and fail, not both and not neither.");
    }

    const headers = args.response === undefined ? undefined : args.response.headers ?? {};

    if (headers !== undefined && Object.keys(headers).length > MOCK_HEADERS_MAX) {
        throw new ToolError(`At most ${MOCK_HEADERS_MAX} headers can be set on a mock response.`);
    }

    let bodyBase64: string | undefined;

    if (args.response?.body !== undefined && args.response.bodyBase64 !== undefined) {
        throw new ToolError("Provide either body or bodyBase64, not both.");
    }

    if (args.response?.body !== undefined) {
        const bytes = Buffer.from(args.response.body, "utf8");

        if (bytes.length > MOCK_BODY_MAX_BYTES) throw bodyTooLarge();

        bodyBase64 = bytes.toString("base64");
    }

    if (args.response?.bodyBase64 !== undefined) {
        const encoded = args.response.bodyBase64;

        if (encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) {
            throw new ToolError("bodyBase64 is not valid base64.");
        }

        if (Buffer.from(args.response.bodyBase64, "base64").length > MOCK_BODY_MAX_BYTES) {
            throw bodyTooLarge();
        }

        bodyBase64 = args.response.bodyBase64;
    }

    const response: MockResponse | undefined = args.response === undefined ? undefined : {
        status     : args.response.status,
        headers    : Object.entries(headers ?? {}).map(([name, value]) => ({ name, value })),
        bodyBase64,
        contentType: args.response.contentType,
    };

    return {
        urlPattern  : args.urlPattern,
        method      : args.method,
        resourceType: args.resourceType,
        response,
        fail        : (args.fail?.reason ?? undefined) as FailReason | undefined,
        delayMs     : args.delayMs ?? 0,
        times       : args.times,
    };
}

export const networkMock = defineTool({
    name: "network_mock",
    description:
        "Mock network responses or fail requests of a tab by URL pattern. The first matching rule in insertion order wins.",
    access: "mutate",
    input : z.strictObject({
        tab   : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        action: z.enum(["add", "remove", "list", "clear"]).describe("What to do."),
        rule  : addSchema.optional().describe("Rule to add, for the add action."),
        id    : z.string().min(1).max(64).optional().describe("Rule id, for the remove action."),
    }),
    output: z.strictObject({
        tab   : z.string().describe("Tab id."),
        action: z.enum(["add", "remove", "list", "clear"]).describe("What ran."),
        effect: z.string().describe("Short summary of what happened."),
        rules : z.array(ruleSchema).describe("Active rules in insertion order."),
    }),
    target: (args) =>
        args.action === "add" && args.rule !== undefined ? { pattern: args.rule.urlPattern } : undefined,
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        throwIfCancelled(context.signal);

        if (args.action === "add") {
            if (args.rule === undefined) {
                throw new ToolError("The add action needs a rule to add.");
            }

            if (args.id !== undefined) {
                throw new ToolError("id only applies to the remove action.");
            }

            const current = context.mock.rulesOf(targetId);

            if (current.length >= MOCK_RULES_MAX) {
                throw new ToolError(
                    `At most ${MOCK_RULES_MAX} mock rules per tab. Remove one first.`,
                );
            }

            const added = context.mock.add(targetId, ruleInputOf(args.rule));

            try {
                await context.mock.sync(targetId);
            } catch (error) {
                context.mock.remove(targetId, added.id);

                throw error;
            }

            return {
                tab   : targetId,
                action: args.action,
                effect: `Rule ${added.id} was added.`,
                rules : summariesOf(context.mock.rulesOf(targetId)),
            };
        }

        if (args.action === "remove") {
            if (args.rule !== undefined) {
                throw new ToolError("rule only applies to the add action.");
            }

            if (args.id === undefined) {
                throw new ToolError("The remove action needs an id.");
            }

            const removed = context.mock.remove(targetId, args.id);

            if (removed === undefined) {
                throw new ToolError(
                    `No mock rule ${JSON.stringify(args.id)} exists in this tab. Call network_mock with action list.`,
                );
            }

            await context.mock.sync(targetId);

            return {
                tab   : targetId,
                action: args.action,
                effect: `Rule ${removed.id} was removed.`,
                rules : summariesOf(context.mock.rulesOf(targetId)),
            };
        }

        if (args.action === "clear") {
            if (args.rule !== undefined || args.id !== undefined) {
                throw new ToolError("The clear action takes no rule or id.");
            }

            const count = context.mock.clear(targetId);

            await context.mock.sync(targetId);

            return {
                tab   : targetId,
                action: args.action,
                effect: count === 1 ? "One rule was cleared." : `${count} rules were cleared.`,
                rules : [],
            };
        }

        if (args.rule !== undefined || args.id !== undefined) {
            throw new ToolError("The list action takes no rule or id.");
        }

        return {
            tab   : targetId,
            action: args.action,
            effect: "Active mock rules.",
            rules : summariesOf(context.mock.rulesOf(targetId)),
        };
    },
});

function summariesOf(rules: ReturnType<InterceptionManager["rulesOf"]>): Array<z.infer<typeof ruleSchema>> {
    return rules.map((rule) => ({
        id          : rule.id,
        urlPattern  : rule.urlPattern,
        ...(rule.method === undefined ? {} : { method: rule.method }),
        ...(rule.resourceType === undefined ? {} : { resourceType: rule.resourceType }),
        kind        : rule.response === undefined ? "fail" as const : "response" as const,
        ...(rule.response === undefined ? {} : { status: rule.response.status }),
        delayMs     : rule.delayMs,
        ...(rule.times === undefined ? {} : { times: rule.times }),
        applications: rule.applications - rule.errors,
        errors      : rule.errors,
        createdAt   : rule.createdAt,
    }));
}
