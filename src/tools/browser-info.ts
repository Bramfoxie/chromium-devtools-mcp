import { z } from "zod";
import { defineTool } from "./define-tool.js";
import { ToolError } from "./errors.js";
import { resolveTab, tabSchema } from "./tab-target.js";

const VERSION_TIMEOUT_MS = 5000;

const versionSchema = z.object({
    protocolVersion: z.string().max(40),
    product        : z.string().max(200),
    revision       : z.string().max(200),
    userAgent      : z.string().max(1000),
    jsVersion      : z.string().max(80),
});

export const browserInfo = defineTool({
    name       : "browser_info",
    untrusted  : false,
    closedWorld: true,
    description:
        "Read the version of the browser the session is connected to, for bug reports and for checking what a page runs on.",
    access: "read",
    input : z.strictObject({ tab: tabSchema }),
    output: z.strictObject({
        tab            : z.string().describe("Tab id the question was sent through."),
        product        : z.string().describe("Browser name and version, for example Chrome/157.0.0.0."),
        revision       : z.string().describe("Revision of the browser build."),
        userAgent      : z.string().describe("The real user agent of the browser, not an emulated one."),
        jsVersion      : z.string().describe("Version of the JavaScript engine."),
        protocolVersion: z.string().describe("Version of the DevTools Protocol."),
        browser        : z.string().describe("The browser setting of the server."),
        mode           : z.string().describe("The connection mode of the server, attach or managed."),
    }),
    handler: async (args, context) => {
        const targetId = resolveTab(args, context);
        const raw = await context.access.send({
            targetId,
            method   : "Browser.getVersion",
            params   : {},
            timeoutMs: VERSION_TIMEOUT_MS,
        });
        const parsed = versionSchema.safeParse(raw);

        if (!parsed.success) {
            throw new ToolError(
                "The browser did not report its version in the expected form. Check that the tab is responsive and try again.",
            );
        }

        return {
            tab    : targetId,
            ...parsed.data,
            browser: context.config.browser,
            mode   : context.config.mode,
        };
    },
});
