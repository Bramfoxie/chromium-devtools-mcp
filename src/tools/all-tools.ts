import { bringToFront } from "./bring-to-front.js";
import { consoleLogs } from "./console-logs.js";
import { cssInspect } from "./css-inspect.js";
import type { AnyTool } from "./define-tool.js";
import { domQuery } from "./dom-query.js";
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
import { networkRequests } from "./network-requests.js";
import { networkResponseBody } from "./network-response-body.js";
import { perfTraceStart, perfTraceStop } from "./perf/perf-trace.js";
import { pageDialogs } from "./page-dialogs.js";
import { pagePdf } from "./page-pdf.js";
import { storageRead } from "./storage-read.js";
import { storageWrite } from "./storage-write.js";
import { pageWait } from "./page-wait.js";
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
    bringToFront,
    pageInfo,
    pageNavigate,
    jsEvaluate,
    domQuery,
    domSnapshot,
    cssInspect,
    consoleLogs,
    networkRequests,
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
