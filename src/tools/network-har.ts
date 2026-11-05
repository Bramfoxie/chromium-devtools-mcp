import { z } from "zod";
import { buildHar } from "./capture/har.js";
import { NETWORK_REGEX_MAX_CHARS } from "./capture/url-pattern.js";
import { defineTool } from "./define-tool.js";
import { networkFilterOf } from "./network-requests.js";
import { resolveTab, tabSchema } from "./tab-target.js";
import { ownVersion } from "../util/package-version.js";

const HAR_MAX_ENTRIES = 5000;

const listOf = (label: string) =>
    z.array(z.string().min(1).max(64)).max(50).optional().describe(label);

export const networkHar = defineTool({
    name: "network_har",
    description:
        "Save the HTTP requests of a tab as a HAR file that DevTools and other tools open, with redacted URLs and headers and no bodies.",
    access: "read",
    input : z.strictObject({
        tab          : tabSchema,
        urlContains  : z.string().min(1).max(1024).optional().describe("Keep only URLs containing this text."),
        urlRegex     : z.string().min(1).max(NETWORK_REGEX_MAX_CHARS).optional().describe("Keep only URLs matching this regular expression."),
        methods      : listOf("Keep only these HTTP methods."),
        resourceTypes: listOf("Keep only these CDP resource types."),
        statusMin    : z.number().int().min(100).max(599).optional().describe("Keep only responses with at least this status."),
        statusMax    : z.number().int().min(100).max(599).optional().describe("Keep only responses with at most this status."),
        failedOnly   : z.boolean().optional().describe("Keep only failed requests."),
        clear        : z.boolean().optional().describe("Empty the network buffer of the tab after saving. Defaults to false."),
    }),
    output: z.strictObject({
        tab : z.string().describe("Tab id."),
        file: z.strictObject({
            path : z.string().describe("Absolute path of the HAR file."),
            bytes: z.number().describe("Size of the file in bytes."),
        }),
        entries     : z.number().describe("Requests in the file."),
        droppedCount: z.number().describe("Records evicted from the buffer since the last read."),
        truncated   : z.boolean().describe(`Whether more than ${HAR_MAX_ENTRIES} requests matched and the oldest were left out.`),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);
        const filter = networkFilterOf(args);

        await context.capture.ensureNetwork(targetId);

        const read = context.capture.readNetwork(targetId, {
            filter,
            afterId: undefined,
            limit  : Number.MAX_SAFE_INTEGER,
            clear  : args.clear ?? false,
        });
        const all = read.records.map(({ record }) => record);
        const kept = all.length > HAR_MAX_ENTRIES ? all.slice(all.length - HAR_MAX_ENTRIES) : all;
        const har = buildHar(kept, { name: "chromium-devtools-mcp", version: ownVersion() });
        const file = await context.artifacts.write("network", "har", JSON.stringify(har));

        return {
            tab         : targetId,
            file,
            entries     : kept.length,
            droppedCount: read.droppedCount,
            truncated   : all.length > kept.length,
        };
    },
});
