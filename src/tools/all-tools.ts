import { bringToFront } from "./bring-to-front.js";
import { consoleLogs } from "./console-logs.js";
import { cssEdit } from "./css-edit.js";
import { cssInspect } from "./css-inspect.js";
import { eventListeners } from "./event-listeners.js";
import { domEdit } from "./dom-edit.js";
import type { AnyTool } from "./define-tool.js";
import { domQuery } from "./dom-query.js";
import { a11ySnapshot } from "./a11y-snapshot.js";
import { domSelector } from "./dom-selector.js";
import { domSnapshot } from "./dom-snapshot.js";
import { emulateDevice } from "./emulation/emulate-device.js";
import { emulateGeolocation } from "./emulation/emulate-geolocation.js";
import { emulateLocale } from "./emulation/emulate-locale.js";
import { emulateMedia } from "./emulation/emulate-media.js";
import { emulateNetwork } from "./emulation/emulate-network.js";
import { listDevices } from "./emulation/list-devices.js";
import { click, inputClick, inputHover } from "./input-click.js";
import { inputDrag } from "./input-drag.js";
import { inputScroll } from "./input-scroll.js";
import { inputSelect } from "./input-select.js";
import { inputKey, inputType } from "./input-text.js";
import { inputUpload } from "./input-upload.js";
import { fillForm } from "./fill-form.js";
import { jsEvaluate } from "./js-evaluate.js";
import { networkMock } from "./network-mock.js";
import { downloads } from "./downloads.js";
import { networkHar } from "./network-har.js";
import { networkRequests } from "./network-requests.js";
import { networkResponseBody } from "./network-response-body.js";
import { lighthouseAudit } from "./perf/lighthouse.js";
import { screencastStart, screencastStop } from "./perf/screencast.js";
import { heapSnapshot } from "./perf/heap-snapshot.js";
import { perfTraceStart, perfTraceStop } from "./perf/perf-trace.js";
import { pageDialogs } from "./page-dialogs.js";
import { pagePdf } from "./page-pdf.js";
import { storageRead } from "./storage-read.js";
import { storageWrite } from "./storage-write.js";
import { pwaInfo } from "./pwa-info.js";
import { webauthn } from "./webauthn.js";
import { pageWait } from "./page-wait.js";
import { screenshot } from "./screenshot.js";
import { pageInfo } from "./page-info.js";
import { pageMetrics } from "./page-metrics.js";
import { pageNavigate } from "./page-navigate.js";
import { closeTab, listSessions, listTabs, newTab, popupList, selectTab, windowList } from "./tabs.js";

export const allTools: AnyTool[] = [
    listTabs,
    popupList,
    windowList,
    listSessions,
    selectTab,
    newTab,
    closeTab,
    bringToFront,
    pageInfo,
    pageNavigate,
    jsEvaluate,
    domQuery,
    domSnapshot,
    a11ySnapshot,
    domSelector,
    domEdit,
    cssInspect,
    eventListeners,
    cssEdit,
    consoleLogs,
    networkRequests,
    networkHar,
    downloads,
    networkResponseBody,
    networkMock,
    pageDialogs,
    pageWait,
    storageRead,
    storageWrite,
    pagePdf,
    pageMetrics,
    perfTraceStart,
    perfTraceStop,
    heapSnapshot,
    screencastStart,
    screencastStop,
    lighthouseAudit,
    webauthn,
    pwaInfo,
    screenshot,
    listDevices,
    emulateDevice,
    emulateMedia,
    emulateNetwork,
    emulateLocale,
    emulateGeolocation,
    click,
    inputClick,
    inputHover,
    inputDrag,
    inputType,
    inputKey,
    inputScroll,
    inputSelect,
    inputUpload,
    fillForm,
];
