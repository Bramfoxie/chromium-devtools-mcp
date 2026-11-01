import { z } from "zod";
import { RpcError, ErrorCode } from "../daemon/index.js";
import { defineTool, type KnownTabShape, type ToolContext } from "./define-tool.js";
import { ToolError } from "./errors.js";

const tabId = z.string().min(1).max(128).describe("Tab id returned by the tab tools.");

const tabObject = z.strictObject({
    tab    : z.string().describe("Tab id."),
    url    : z.string().describe("URL of the tab."),
    title  : z.string().describe("Title of the tab."),
    owned  : z.boolean().describe("Whether this session owns the tab."),
    created: z.boolean().describe("Whether this session created the tab."),
});

export function selectionOf(tabs: Array<{ targetId: string }>, selected: string | undefined) {
    return selected !== undefined && tabs.some((tab) => tab.targetId === selected)
        ? selected
        : undefined;
}

async function refresh(
    context : ToolContext,
    selected: string | undefined,
): Promise<KnownTabShape[]> {
    const tabs = await context.access.listTabs("owned");

    context.tabs.refresh(tabs, selected);

    return tabs;
}

function noTabError(): ToolError {
    return new ToolError("No tab is selected. Open one with new_tab first.");
}

export const newTab = defineTool({
    name       : "new_tab",
    description: "Open a new background tab and select it.",
    access     : "mutate",
    input      : z.strictObject({
        url   : z.string().min(1).max(2048).optional().describe("URL to open, http or https. Defaults to about:blank."),
        select: z.boolean().optional().describe("Select the new tab. Defaults to true."),
    }),
    output : z.strictObject({ tab: tabObject }),
    target : (args) => (args.url === undefined ? undefined : { url: args.url }),
    handler: async (args, context) => {
        const targetId = await context.access.createTab(args.url);
        const select = args.select === false ? context.state.selected : targetId;
        const tabs = await refresh(context, select);
        const tab = tabs.find((known) => known.targetId === targetId) ?? {
            targetId,
            url    : args.url ?? "about:blank",
            title  : "",
            owned  : true,
            created: true,
        };

        return {
            tab: { tab: tab.targetId, url: tab.url, title: tab.title, owned: true, created: true },
        };
    },
});

export const listTabs = defineTool({
    name       : "list_tabs",
    description: "List tabs of the session or tabs available to claim.",
    access     : "read",
    input      : z.strictObject({
        scope: z.enum(["owned", "available"]).optional().describe("Owned tabs or tabs available to claim. Defaults to owned."),
    }),
    output: z.strictObject({
        tabs: z.array(
            tabObject.extend({
                selected: z.boolean().describe("Whether the tab is the selected one."),
            }),
        ),
    }),
    handler: async (args, context) => {
        const scope = args.scope ?? "owned";
        const tabs = await context.access.listTabs(scope);

        if (scope === "owned") {
            const selected = selectionOf(tabs, context.state.selected);

            context.tabs.refresh(tabs, selected);

            return {
                tabs: tabs.map((tab) => ({
                    tab     : tab.targetId,
                    url     : tab.url,
                    title   : tab.title,
                    owned   : tab.owned,
                    created : tab.created,
                    selected: tab.targetId === selected,
                })),
            };
        }

        return {
            tabs: tabs.map((tab) => ({
                tab     : tab.targetId,
                url     : tab.url,
                title   : tab.title,
                owned   : false,
                created : false,
                selected: false,
            })),
        };
    },
});

export const selectTab = defineTool({
    name       : "select_tab",
    description: "Select a tab of the session, claiming an available tab when needed.",
    access     : "mutate",
    input      : z.strictObject({ tab: tabId }),
    output     : z.strictObject({ tab: tabObject }),
    handler    : async (args, context) => {
        let tabs = await context.access.listTabs("owned");
        let tab = tabs.find((known) => known.targetId === args.tab);

        if (!tab) {
            try {
                await context.access.claimTab(args.tab);
            } catch (error) {
                if (error instanceof RpcError && error.code === ErrorCode.alreadyClaimed) {
                    throw new ToolError(
                        "The tab is already used by another session. Call list_tabs to see the open tabs.",
                    );
                }

                if (error instanceof RpcError && error.code === ErrorCode.notFound) {
                    throw new ToolError(
                        "No such tab is available to this session. Call list_tabs to see the open tabs.",
                    );
                }

                throw error;
            }

            tabs = await context.access.listTabs("owned");
            tab = tabs.find((known) => known.targetId === args.tab);

            if (!tab) throw new ToolError("The tab was claimed but is no longer listed. Call list_tabs to see the open tabs.");
        }

        context.tabs.refresh(tabs, tab.targetId);

        return {
            tab: {
                tab    : tab.targetId,
                url    : tab.url,
                title  : tab.title,
                owned  : true,
                created: tab.created,
            },
        };
    },
});

export const closeTab = defineTool({
    name       : "close_tab",
    description: "Close a tab opened by this session.",
    access     : "mutate",
    input      : z.strictObject({ tab: tabId.optional().describe("Tab id. Defaults to the selected tab.") }),
    output     : z.strictObject({
        closed  : z.string().describe("Id of the closed tab."),
        selected: z.string().nullable().describe("Id of the newly selected tab, if any."),
    }),
    handler: async (args, context) => {
        const targetId = args.tab ?? context.state.selected;

        if (targetId === undefined) throw noTabError();

        try {
            await context.access.closeTab(targetId);
        } catch (error) {
            if (error instanceof RpcError && error.code === ErrorCode.notCreated) {
                throw new ToolError(
                    "Only tabs opened by this session can be closed. A claimed tab is released when the session ends.",
                );
            }

            throw error;
        }

        const tabs = await context.access.listTabs("owned");
        const kept = tabs.some((tab) => tab.targetId === context.state.selected);
        const selected = kept && context.state.selected !== targetId
            ? context.state.selected
            : undefined;
        const next = selected !== undefined && tabs.some((tab) => tab.targetId === selected)
            ? selected
            : tabs[0]?.targetId;

        context.tabs.refresh(tabs, next);

        return { closed: targetId, selected: next ?? null };
    },
});

export const listSessions = defineTool({
    name       : "list_sessions",
    description: "List open sessions of the daemon without their tab details.",
    access     : "read",
    input      : z.strictObject({}),
    output     : z.strictObject({
        sessions: z.array(
            z.strictObject({
                sessionId : z.string().describe("Opaque session id."),
                clientName: z.string().describe("Name of the connected client."),
                isolated  : z.boolean().describe("Whether the session uses an isolated browser context."),
                tabs      : z.number().describe("Number of tabs the session owns."),
                own       : z.boolean().describe("Whether this is the calling session."),
            }),
        ),
    }),
    handler: async (_args, context) => ({ sessions: await context.access.listSessions() }),
});
