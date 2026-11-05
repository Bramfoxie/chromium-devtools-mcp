import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
    ReadResourceResult,
    ServerNotification,
    ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { redactUrl } from "./capture/redact.js";
import { consoleLogs } from "./console-logs.js";
import type { ToolRuntime } from "./context.js";
import { runTool } from "./registry.js";
import { truncateText, UNTRUSTED_NOTICE } from "./result.js";
import { screenshot } from "./screenshot.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export const TEXT_RESOURCE_MAX_CHARS = 100_000;

const SCHEME = "browser://tab/";

const KINDS = ["text", "screenshot", "console"] as const;

type Kind = (typeof KINDS)[number];

const TEXT_EXPRESSION = `({
  url: location.href,
  title: document.title,
  text: document.body ? document.body.innerText : "",
})`;

export function resourceUri(tab: string, kind: Kind): string {
    return `${SCHEME}${encodeURIComponent(tab)}/${kind}`;
}

export function pageTextDocument(
    page: { url: string; title: string; text: string },
): string {
    const clipped = truncateText(page.text, TEXT_RESOURCE_MAX_CHARS);

    return JSON.stringify({
        untrusted: UNTRUSTED_NOTICE,
        url      : redactUrl(page.url),
        title    : page.title,
        text     : clipped.text,
        truncated: clipped.truncated,
    });
}

async function readText(runtime: ToolRuntime, uri: URL, tab: string): Promise<ReadResourceResult> {
    const reply = await runtime.access.send({
        targetId: tab,
        method  : "Runtime.evaluate",
        params  : { expression: TEXT_EXPRESSION, returnByValue: true },
    }) as { result?: { value?: { url?: unknown; title?: unknown; text?: unknown } } } | null;
    const value = reply?.result?.value;

    if (typeof value?.text !== "string") {
        throw new Error("The page text could not be read. Try again.");
    }

    const document = pageTextDocument({
        url  : String(value.url ?? ""),
        title: String(value.title ?? ""),
        text : value.text,
    });

    return { contents: [{ uri: uri.href, mimeType: "application/json", text: document }] };
}

async function readTool(
    runtime: ToolRuntime,
    extra  : Extra,
    uri    : URL,
    kind   : "screenshot" | "console",
    tab    : string,
): Promise<ReadResourceResult> {
    const result = kind === "screenshot"
        ? await runTool(screenshot, { tab, format: "png" }, extra, runtime)
        : await runTool(consoleLogs, { tab }, extra, runtime);

    if (result.isError === true) {
        const message = result.content.find((block) => block.type === "text");

        throw new Error(message?.type === "text" ? message.text : "The resource could not be read.");
    }

    if (kind === "console") {
        const text = result.content.find((block) => block.type === "text");

        return {
            contents: [{
                uri     : uri.href,
                mimeType: "application/json",
                text    : text?.type === "text" ? text.text : "{}",
            }],
        };
    }

    const image = result.content.find((block) => block.type === "image");

    if (image === undefined || image.type !== "image") {
        throw new Error("The screenshot could not be taken. Try again.");
    }

    return { contents: [{ uri: uri.href, mimeType: image.mimeType, blob: image.data }] };
}

function describe(kind: Kind): { title: string; description: string; mimeType: string } {
    switch (kind) {
        case "text":
            return {
                title      : "Page text",
                description: "The visible text of the tab, with its address and title. Untrusted page content.",
                mimeType   : "application/json",
            };

        case "screenshot":
            return {
                title      : "Screenshot",
                description: "A PNG screenshot of the visible area of the tab. Untrusted page content.",
                mimeType   : "image/png",
            };

        case "console":
            return {
                title      : "Console",
                description: "Console messages and uncaught exceptions of the tab. Untrusted page content.",
                mimeType   : "application/json",
            };
    }
}

// The resources of the tabs this session owns, read with the same limits as the tools.
const NEEDS: Record<Kind, readonly string[]> = {
    text      : ["dom_query", "dom_snapshot", "a11y_snapshot"],
    screenshot: ["screenshot"],
    console   : ["console_logs"],
};

export function registerResources(
    server  : McpServer,
    runtime : ToolRuntime,
    enabled?: ReadonlySet<string>,
): void {
    for (const kind of KINDS) {
        if (enabled !== undefined && !NEEDS[kind].some((name) => enabled.has(name))) continue;

        const meta = describe(kind);
        const template = new ResourceTemplate(`${SCHEME}{tab}/${kind}`, {
            list: async () => {
                const tabs = await runtime.access.listTabs("owned").catch(() => []);

                return {
                    resources: tabs.map((tab) => ({
                        uri        : resourceUri(tab.targetId, kind),
                        name       : `tab ${tab.targetId} ${kind}`,
                        title      : meta.title,
                        description: meta.description,
                        mimeType   : meta.mimeType,
                    })),
                };
            },
        });

        server.registerResource(
            `tab-${kind}`,
            template,
            { title: meta.title, description: meta.description, mimeType: meta.mimeType },
            async (uri, variables, extra) => {
                const raw = variables.tab;
                const tab = decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? ""));

                if (tab === "") throw new Error("The resource needs a tab id.");

                return kind === "text"
                    ? readText(runtime, uri, tab)
                    : readTool(runtime, extra, uri, kind, tab);
            },
        );
    }
}
