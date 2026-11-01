import { z } from "zod";

export const CONSOLE_ENTRY_CLIP_CHARS = 2000;

export const CONSOLE_STACK_FRAMES = 20;

export type ConsoleLevel = "debug" | "info" | "warning" | "error";

export type ConsoleSource = "console" | "exception" | "browser";

export interface ConsoleEntry {
    time   : string;
    level  : ConsoleLevel;
    source : ConsoleSource;
    text   : string;
    url?   : string;
    line?  : number;
    column?: number;
    stack? : string;
}

const remoteObject = z.object({
    type               : z.string(),
    subtype            : z.string().optional(),
    className          : z.string().optional(),
    value              : z.unknown().optional(),
    unserializableValue: z.string().optional(),
    description        : z.string().optional(),
});

const consoleApiCalled = z.object({
    type      : z.string(),
    args      : z.array(remoteObject),
    stackTrace: z
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
});

const exceptionThrown = z.object({
    exceptionDetails: z.object({
        text        : z.string(),
        lineNumber  : z.number().optional(),
        columnNumber: z.number().optional(),
        url         : z.string().optional(),
        exception   : remoteObject.optional(),
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
    }),
});

const logEntryAdded = z.object({
    entry: z.object({
        source    : z.string(),
        level     : z.string(),
        text      : z.string(),
        url       : z.string().optional(),
        lineNumber: z.number().optional(),
    }),
});

type RemoteArgument = z.infer<typeof remoteObject>;

type CallFrame = { functionName: string; url: string; lineNumber: number; columnNumber: number };

export function clipConsoleText(text: string): string {
    const chars = [...text];

    if (chars.length <= CONSOLE_ENTRY_CLIP_CHARS) return text;

    return `${chars.slice(0, CONSOLE_ENTRY_CLIP_CHARS).join("")}...`;
}

export function formatConsoleArgument(argument: RemoteArgument): string {
    if (argument.unserializableValue !== undefined) return argument.unserializableValue;

    if (argument.value !== undefined) {
        if (typeof argument.value === "string") return argument.value;

        const text = JSON.stringify(argument.value);

        return text === undefined ? argument.type : text;
    }

    if (argument.description !== undefined) return argument.description;

    const name = argument.className ?? argument.subtype ?? argument.type;

    return name === "object" ? "Object" : name;
}

export function formatConsoleStack(frames: CallFrame[]): string {
    return frames
        .slice(0, CONSOLE_STACK_FRAMES)
        .map(
            (frame) =>
                `${frame.functionName || "(anonymous)"} (${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`,
        )
        .join("\n");
}

function levelOfConsoleType(type: string): ConsoleLevel {
    if (type === "error" || type === "assert") return "error";
    if (type === "warning") return "warning";
    if (type === "debug") return "debug";

    return "info";
}

function levelOfLogLevel(level: string): ConsoleLevel {
    if (level === "error") return "error";
    if (level === "warning") return "warning";
    if (level === "verbose") return "debug";

    return "info";
}

interface FrameLocation {
    url?   : string;
    line?  : number;
    column?: number;
}

function locationOf(frames: CallFrame[] | undefined): FrameLocation {
    const first = frames?.[0];

    if (first === undefined) return {};

    return { url: first.url, line: first.lineNumber + 1, column: first.columnNumber + 1 };
}

export function normalizeConsoleEvent(
    event : string,
    params: unknown,
    now   : string,
): ConsoleEntry | undefined {
    if (event === "Runtime.consoleAPICalled") {
        const parsed = consoleApiCalled.safeParse(params);

        if (!parsed.success) return undefined;

        const frames = parsed.data.stackTrace?.callFrames ?? [];
        const text = clipConsoleText(parsed.data.args.map(formatConsoleArgument).join(" "));
        const stack = formatConsoleStack(frames);

        return {
            time  : now,
            level : levelOfConsoleType(parsed.data.type),
            source: "console",
            text,
            ...locationOf(frames),
            ...(stack === "" ? {} : { stack }),
        };
    }

    if (event === "Runtime.exceptionThrown") {
        const parsed = exceptionThrown.safeParse(params);

        if (!parsed.success) return undefined;

        const details = parsed.data.exceptionDetails;
        const description = details.exception?.description;
        const text = clipConsoleText(
            description !== undefined && description !== "" ? description : details.text,
        );
        const frames = details.stackTrace?.callFrames ?? [];
        const stack = formatConsoleStack(frames);
        const url = details.url ?? frames[0]?.url;
        const line = details.lineNumber === undefined ? frames[0]?.lineNumber : details.lineNumber;
        const column = details.columnNumber === undefined
            ? frames[0]?.columnNumber
            : details.columnNumber;

        return {
            time  : now,
            level : "error",
            source: "exception",
            text,
            ...(url === undefined ? {} : { url }),
            ...(line === undefined ? {} : { line: line + 1 }),
            ...(column === undefined ? {} : { column: column + 1 }),
            ...(stack === "" ? {} : { stack }),
        };
    }

    if (event === "Log.entryAdded") {
        const parsed = logEntryAdded.safeParse(params);

        if (!parsed.success) return undefined;

        const entry = parsed.data.entry;

        return {
            time  : now,
            level : levelOfLogLevel(entry.level),
            source: "browser",
            text  : clipConsoleText(entry.text),
            ...(entry.url === undefined ? {} : { url: entry.url }),
            ...(entry.lineNumber === undefined ? {} : { line: entry.lineNumber + 1 }),
        };
    }

    return undefined;
}
