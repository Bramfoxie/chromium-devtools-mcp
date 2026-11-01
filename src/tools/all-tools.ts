import { consoleLogs } from "./console-logs.js";
import { cssInspect } from "./css-inspect.js";
import type { AnyTool } from "./define-tool.js";
import { domQuery } from "./dom-query.js";
import { domSnapshot } from "./dom-snapshot.js";
import { click, inputClick, inputHover } from "./input-click.js";
import { inputScroll } from "./input-scroll.js";
import { inputSelect } from "./input-select.js";
import { inputKey, inputType } from "./input-text.js";
import { inputUpload } from "./input-upload.js";
import { jsEvaluate } from "./js-evaluate.js";
import { networkRequests } from "./network-requests.js";
import { networkResponseBody } from "./network-response-body.js";
import { pagePdf } from "./page-pdf.js";
import { screenshot } from "./screenshot.js";
import { pageInfo } from "./page-info.js";
import { pageMetrics } from "./page-metrics.js";
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
    consoleLogs,
    networkRequests,
    networkResponseBody,
    pagePdf,
    pageMetrics,
    screenshot,
    click,
    inputClick,
    inputHover,
    inputType,
    inputKey,
    inputScroll,
    inputSelect,
    inputUpload,
];
