import { cssInspect } from "./css-inspect.js";
import type { AnyTool } from "./define-tool.js";
import { domQuery } from "./dom-query.js";
import { domSnapshot } from "./dom-snapshot.js";
import { click, inputClick, inputHover } from "./input-click.js";
import { jsEvaluate } from "./js-evaluate.js";
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
    jsEvaluate,
    domQuery,
    domSnapshot,
    cssInspect,
    click,
    inputClick,
    inputHover,
];
