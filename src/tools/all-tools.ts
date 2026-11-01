import type { AnyTool } from "./define-tool.js";
import { pageInfo } from "./page-info.js";
import { pageNavigate } from "./page-navigate.js";
import { closeTab, listSessions, listTabs, newTab, selectTab } from "./tabs.js";

export const allTools: AnyTool[] = [
    listTabs,
    listSessions,
    selectTab,
    newTab,
    closeTab,
    pageInfo,
    pageNavigate,
];
