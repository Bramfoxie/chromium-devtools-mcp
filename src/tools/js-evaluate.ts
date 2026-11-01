import { z } from "zod";
import { ErrorCode, RpcError } from "../daemon/index.js";
import type { DaemonAccess } from "../mcp/index.js";
import { defineTool } from "./define-tool.js";
import { ensureNoDialog } from "./dialogs.js";
import {
    type ElementRegistry,
    type ElementTarget,
    elementTargetSchema,
    resolveElement,
} from "./element-target.js";
import { ToolError } from "./errors.js";
import { truncateText } from "./result.js";

export const EVALUATE_DEFAULT_TIMEOUT_MS = 10_000;

export const EVALUATE_MAX_TIMEOUT_MS = 60_000;

export const EVALUATE_MAX_EXPRESSION_CHARS = 100_000;

export const EVALUATE_DEFAULT_RESULT_CHARS = 50_000;

export const EVALUATE_MAX_RESULT_CHARS = 200_000;

export const EVALUATE_MAX_STACK_CHARS = 2000;

export function isFunctionExpression(source: string): boolean {
    const text = source.trimStart();

    if (/^(async\s+)?function\b/.test(text)) return true;
    if (/^async\s*\(/.test(text)) return true;
    if (/^\(/.test(text)) return text.includes("=>");

    return /^[A-Za-z_$][\w$]*\s*=>/.test(text);
}

export function elementFunctionDeclaration(expression: string): string {
    if (isFunctionExpression(expression)) return expression;

    return `function (element) { ${expression} }`;
}

const remoteSchema = z.object({
    type               : z.string(),
    subtype            : z.string().optional(),
    className          : z.string().optional(),
    value              : z.unknown().optional(),
    unserializableValue: z.string().optional(),
    description        : z.string().optional(),
    objectId           : z.string().optional(),
});

const evaluatedSchema = z.object({
    result          : remoteSchema,
    exceptionDetails: z
        .object({
            text        : z.string(),
            lineNumber  : z.number().optional(),
            columnNumber: z.number().optional(),
            exception   : remoteSchema.optional(),
            stackTrace  : z
                .object({
                    callFrames: z.array(
                        z.object({
                            functionName: z.string(),
                            url         : z.string(),
                            lineNumber  : z.number(),
                            columnNumber: z.number(),
                        }),
                    ),
                })
                .optional(),
        })
        .optional(),
});

type RemoteObject = z.infer<typeof remoteSchema>;

type Evaluated = z.infer<typeof evaluatedSchema>;

export function formatExceptionStack(exception: NonNullable<Evaluated["exceptionDetails"]>): string {
    const frames = exception.stackTrace?.callFrames ?? [];

    if (frames.length === 0) return "";

    const lines = frames.map(
        (frame) => `${frame.functionName} (${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`,
    );

    return truncateText(lines.join("\n"), EVALUATE_MAX_STACK_CHARS).text;
}

export interface ShapedValue {
    type       : string;
    value      : unknown;
    truncated  : boolean;
    totalLength: number;
}

export function exceptionText(exception: NonNullable<Evaluated["exceptionDetails"]>): string {
    const description = exception.exception?.description;

    if (description !== undefined && description !== "") return description.split("\n")[0] ?? exception.text;

    return exception.text;
}

export function isBareEmptyObject(remote: RemoteObject): boolean {
    return remote.type === "object" &&
        remote.subtype === undefined &&
        remote.objectId === undefined &&
        remote.description === undefined &&
        remote.unserializableValue === undefined &&
        typeof remote.value === "object" &&
        remote.value !== null &&
        Object.keys(remote.value).length === 0;
}

export function shapeRemoteValue(remote: RemoteObject, maxChars: number): ShapedValue {
    const type = remote.subtype ?? remote.type;
    const described = remote.description ?? remote.className ?? remote.type;
    const hasValue = "value" in remote && remote.value !== undefined &&
        (remote.objectId === undefined || remote.subtype === "null" || remote.subtype === "array" || remote.type !== "object");

    if (!hasValue) {
        const text = remote.unserializableValue ?? described;
        const shaped = truncateText(text, maxChars);

        return {
            type,
            value      : shaped.text,
            truncated  : shaped.truncated,
            totalLength: shaped.totalLength,
        };
    }

    const text = JSON.stringify(remote.value) ?? "undefined";
    const shaped = truncateText(text, maxChars);

    if (!shaped.truncated) {
        return {
            type,
            value      : remote.value,
            truncated  : false,
            totalLength: shaped.totalLength,
        };
    }

    return { type, value: shaped.text, truncated: true, totalLength: shaped.totalLength };
}

const evaluatedOutput = z.strictObject({
    ok       : z.boolean().describe("False when the page threw an exception instead of returning a value."),
    type     : z.string().optional().describe("CDP type of the result, with the subtype when present."),
    value    : z.unknown().optional().describe("The value, or a truncated string with a marker when it exceeds maxResultChars."),
    truncated: z.boolean().optional().describe("Whether the value was truncated."),
    exception: z.strictObject({
        text        : z.string().describe("Exception text from the page."),
        lineNumber  : z.number().optional().describe("Line number of the exception, when known."),
        columnNumber: z.number().optional().describe("Column number of the exception, when known."),
        stack       : z.string().optional().describe("Bounded stack trace, when known."),
    }).optional().describe("Page exception details, present only when ok is false."),
});

export const jsEvaluate = defineTool({
    name: "js_evaluate",
    description:
        "Run JavaScript in a tab and return the result. Page exceptions come back as data, not as tool errors.",
    access: "mutate",
    input : z.strictObject({
        tab           : z.string().min(1).max(128).optional().describe("Tab id. Defaults to the selected tab."),
        expression    : z.string().min(1).max(EVALUATE_MAX_EXPRESSION_CHARS).describe("JavaScript expression to evaluate."),
        awaitPromise  : z.boolean().optional().describe("Await a promise result. Defaults to true."),
        timeoutMs     : z.number().int().min(1).max(EVALUATE_MAX_TIMEOUT_MS).optional().describe("How long to wait for the result. Defaults to 10000 ms."),
        maxResultChars: z.number().int().min(1).max(EVALUATE_MAX_RESULT_CHARS).optional().describe("Maximum characters of the returned value. Defaults to 50000."),
        target        : elementTargetSchema.optional().describe(
            "Run the expression against an element. A function expression is called as is, anything else runs as the body of function (element) { ... }. Both receive the element as this and as the first argument.",
        ),
    }),
    output : evaluatedOutput,
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) {
            throw new ToolError("No tab is selected. Open one with new_tab first.");
        }

        await ensureNoDialog(context.dialogs, targetId);

        const awaitPromise = args.awaitPromise ?? true;
        const timeoutMs = args.timeoutMs ?? EVALUATE_DEFAULT_TIMEOUT_MS;
        const maxChars = args.maxResultChars ?? EVALUATE_DEFAULT_RESULT_CHARS;

        let result: unknown;

        try {
            result = await evaluate(context.access, context.elements, targetId, {
                expression: args.expression,
                awaitPromise,
                timeoutMs,
                target    : args.target,
                frames    : context.frames,
            });
        } catch (error) {
            if (error instanceof RpcError && error.code === ErrorCode.cdpTimeout) {
                await context.access.send(targetId, "Runtime.terminateExecution", {}).catch(() => undefined);

                throw new ToolError(
                    `The script did not finish within ${timeoutMs} ms and was stopped. Simplify the script or raise timeoutMs.`,
                );
            }

            throw error;
        }

        const parsed = evaluatedSchema.safeParse(result);

        if (!parsed.success) {
            throw new ToolError(
                "The browser sent an unexpected response to Runtime.evaluate. Try the call again.",
            );
        }

        const exception = parsed.data.exceptionDetails;

        if (exception !== undefined) {
            const stack = formatExceptionStack(exception);

            const line = exception.lineNumber === undefined
                ? {}
                : { lineNumber: exception.lineNumber };
            const column = exception.columnNumber === undefined
                ? {}
                : { columnNumber: exception.columnNumber };

            return {
                ok       : false as const,
                exception: {
                    text: exceptionText(exception),
                    ...line,
                    ...column,
                    ...(stack === "" ? {} : { stack }),
                },
            };
        }

        const objectId = parsed.data.result.objectId;
        const shaped = shapeRemoteValue(parsed.data.result, maxChars);

        if (objectId !== undefined) {
            await context.access.send(targetId, "Runtime.releaseObject", { objectId }).catch(
                () => undefined,
            );
        }

        return {
            ok       : true as const,
            type     : shaped.type,
            value    : shaped.value,
            truncated: shaped.truncated,
        };
    },
});

interface EvaluateRequest {
    expression  : string;
    awaitPromise: boolean;
    timeoutMs   : number;
    target      : ElementTarget | undefined;
    frames?     : import("./frames.js").FrameState;
}

async function evaluate(
    access  : DaemonAccess,
    elements: ElementRegistry,
    targetId: string,
    request : EvaluateRequest,
): Promise<unknown> {
    // One evaluation only: retrying would run page side effects twice.
    if (request.target === undefined) {
        return await access.send(
            targetId,
            "Runtime.evaluate",
            {
                expression     : request.expression,
                returnByValue  : false,
                awaitPromise   : request.awaitPromise,
                userGesture    : false,
                replMode       : false,
                generatePreview: true,
            },
            request.timeoutMs,
        );
    }

    const element = await resolveElement(access, elements, targetId, request.target, {
        frames: request.frames,
    });

    return await access.send(
        targetId,
        "Runtime.callFunctionOn",
        {
            functionDeclaration: elementFunctionDeclaration(request.expression),
            objectId           : element.objectId,
            arguments          : [{ objectId: element.objectId }],
            returnByValue      : false,
            awaitPromise       : request.awaitPromise,
            userGesture        : false,
            generatePreview    : true,
        },
        request.timeoutMs,
    );
}
