import { z } from "zod";
import { RpcError, ErrorCode, normalizeUrl } from "../daemon/index.js";
import { defineTool } from "./define-tool.js";
import { parkIfForbidden } from "./final-url.js";
import { ToolError } from "./errors.js";
import { NAVIGATE_DEFAULT_TIMEOUT_MS, NAVIGATE_MAX_TIMEOUT_MS, loadInTab, type TabLoad } from "./page-navigate.js";
import { truncateText } from "./result.js";

const TAB_URL_MAX_CHARS = 2000;
const TAB_TITLE_MAX_CHARS = 500;

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

function noTabError(): ToolError {
    return new ToolError("No tab is selected. Open one with new_tab first.");
}

export const newTab = defineTool({
    name        : "new_tab",
    description : "Open a new background tab and select it. With a url it waits until the page has loaded or timeoutMs passes, and returns the committed url, the load state reached and the document readyState.",
    access      : "mutate",
    tabUrlExempt: true,
    input       : z.strictObject({
        url      : z.string().min(1).max(2048).optional().describe("URL to open: http, https or about:blank. Defaults to about:blank."),
        select   : z.boolean().optional().describe("Select the new tab. Defaults to true."),
        timeoutMs: z.number().int().min(1).max(NAVIGATE_MAX_TIMEOUT_MS).optional().describe("How long to wait for the page to load. Defaults to 30000 ms."),
    }),
    output: z.strictObject({
        tab            : tabObject,
        waited         : z.enum(["load", "timeout", "none"]).describe("load: the load event fired. timeout: the page was still loading. none: nothing was loaded or the navigation did not start."),
        readyState     : z.string().optional().describe("Document ready state of the tab."),
        status         : z.number().optional().describe("HTTP status of the main document, when observed."),
        navigationError: z.string().optional().describe("Why the url was not loaded, for example a download, an empty 204 response or a network error. The tab stays open."),
    }),
    target : (args) => (args.url === undefined ? undefined : { url: args.url }),
    handler: async (args, context) => {
        const url = args.url === undefined ? undefined : normalizeUrl(args.url);
        const targetId = await context.access.createTab();

        await context.capture.ensureConsole(targetId).catch(() => undefined);
        await context.dialogs.ensure(targetId).catch(() => undefined);
        await context.frames.ensure(targetId).catch(() => undefined);

        const timeoutMs = args.timeoutMs ?? NAVIGATE_DEFAULT_TIMEOUT_MS;
        const loaded: TabLoad | undefined = url === undefined || url === "about:blank"
            ? undefined
            : await loadInTab(context, targetId, url, timeoutMs);
        const refusal = loaded === undefined
            ? undefined
            : await parkIfForbidden(context, targetId, loaded.page.url);
        const load: TabLoad | undefined = loaded === undefined || refusal === undefined
            ? loaded
            : {
                waited         : "none",
                page           : { url: "about:blank", title: "", readyState: "complete" },
                navigationError: refusal,
            };
        const tabs = await context.access.listTabs("owned");
        const select = args.select === false ? selectionOf(tabs, context.state.selected) : targetId;

        context.tabs.refresh(tabs, select);
        const tab = tabs.find((known) => known.targetId === targetId) ?? {
            targetId,
            url    : "about:blank",
            title  : "",
            owned  : true,
            created: true,
        };
        const page = load?.page.url ? load.page : undefined;

        return {
            tab: {
                tab    : tab.targetId,
                url    : page?.url ?? tab.url,
                title  : page?.title ?? tab.title,
                owned  : true,
                created: true,
            },
            waited: load?.waited ?? "load" as const,
            ...(load === undefined ? {} : { readyState: load.page.readyState }),
            ...(load?.status === undefined ? {} : { status: load.status }),
            ...(load?.navigationError === undefined
                ? {}
                : { navigationError: load.navigationError }),
        };
    },
});

export const listTabs = defineTool({
    name       : "list_tabs",
    closedWorld: true,
    description: "List tabs of the session or tabs available to claim.",
    access     : "read",
    input      : z.strictObject({
        scope: z.enum(["owned", "available"]).optional().describe("Owned tabs or tabs available to claim. Defaults to owned."),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum tabs to return. Defaults to 100."),
    }),
    output: z.strictObject({
        tabs: z.array(
            tabObject.extend({
                selected: z.boolean().describe("Whether the tab is the selected one."),
            }),
        ),
        total    : z.number().describe("Tabs available in this scope before the limit."),
        truncated: z.boolean().describe("Whether the limit dropped tabs."),
    }),
    handler: async (args, context) => {
        const scope = args.scope ?? "owned";
        const limit = args.limit ?? 100;
        const tabs = await context.access.listTabs(scope);

        const slice = (list: typeof tabs) => list.slice(0, limit).map((tab) => ({
            tab    : tab.targetId,
            url    : truncateText(tab.url, TAB_URL_MAX_CHARS).text,
            title  : truncateText(tab.title, TAB_TITLE_MAX_CHARS).text,
            owned  : tab.owned,
            created: tab.created,
        }));

        if (scope === "owned") {
            const selected = selectionOf(tabs, context.state.selected);

            context.tabs.refresh(tabs, selected);

            return {
                tabs     : slice(tabs).map((tab) => ({ ...tab, selected: tab.tab === selected })),
                total    : tabs.length,
                truncated: tabs.length > limit,
            };
        }

        return {
            tabs: slice(tabs).map((tab) => ({
                ...tab,
                owned   : false,
                created : false,
                selected: false,
            })),
            total    : tabs.length,
            truncated: tabs.length > limit,
        };
    },
});

export const selectTab = defineTool({
    name        : "select_tab",
    closedWorld : true,
    description : "Select a tab of the session, claiming an available tab when needed.",
    access      : "mutate",
    tabUrlExempt: true,
    input       : z.strictObject({ tab: tabId }),
    output      : z.strictObject({ tab: tabObject }),
    handler     : async (args, context) => {
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
        await context.capture.ensureConsole(tab.targetId).catch(() => undefined);
        await context.dialogs.ensure(tab.targetId).catch(() => undefined);
        await context.frames.ensure(tab.targetId).catch(() => undefined);

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
    name        : "close_tab",
    closedWorld : true,
    description : "Close a tab opened by this session.",
    access      : "mutate",
    tabUrlExempt: true,
    input       : z.strictObject({ tab: tabId.optional().describe("Tab id. Defaults to the selected tab.") }),
    output      : z.strictObject({
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

        context.capture.forget(targetId);
        context.dialogs.forget(targetId);
        context.frames.forget(targetId);
        context.elements.forget(targetId);
        await context.mock.forget(targetId);
        context.emulation.forget(targetId);

        const tabs = await context.access.listTabs("owned");
        const rest = tabs.filter((tab) => tab.targetId !== targetId);
        const next = context.state.selected === targetId
            ? rest[0]?.targetId
            : selectionOf(tabs, context.state.selected);

        context.tabs.refresh(tabs, next);

        return { closed: targetId, selected: next ?? null };
    },
});

export const listSessions = defineTool({
    name       : "list_sessions",
    closedWorld: true,
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
