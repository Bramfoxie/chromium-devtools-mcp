export { allTools } from "./all-tools.js";

export {
    type AnyTool,
    defineTool,
    type SessionState,
    type TabSelection,
    type ToolAccess,
    type ToolClock,
    type ToolContext,
    type ToolDefinition,
} from "./define-tool.js";

export { SessionTabs, ToolRuntime, type ToolRuntimeOptions } from "./context.js";

export { ToolError, toToolMessage } from "./errors.js";

export { CANCELLED_MESSAGE, registerTools, runTool, throwIfCancelled } from "./registry.js";

export {
    binaryResult,
    type BinaryContent,
    errorResult,
    imageBlock,
    jsonResult,
    resourceBlock,
    textBlock,
    type TruncatedText,
    truncateText,
} from "./result.js";

export {
    type SafetyAccess,
    checkSafety,
    type SafetyDecision,
    type SafetyRequest,
    type SafetyTarget,
} from "./safety.js";

export {
    buildQueryScript,
    clipValue,
    DEFAULT_QUERY_ATTRIBUTES,
    domQuery,
    isPasswordInput,
    QUERY_CLIP_CHARS,
    QUERY_DEFAULT_LIMIT,
    QUERY_MAX_LIMIT,
    QUERY_MAX_TEXT_CHARS,
    type QueryRow,
    roundRect,
} from "./dom-query.js";

export {
    type AxDomInfo,
    AX_NAME_CLIP,
    AX_VALUE_CLIP,
    type AxFormatOptions,
    type AxFormatResult,
    type AxNode,
    formatAxTree,
    type RawAxNode,
    toAxNodes,
} from "./ax-format.js";

export {
    domInfoMap,
    domSnapshot,
    SNAPSHOT_DEFAULT_CHARS,
    SNAPSHOT_DOM_ATTRS,
    SNAPSHOT_DOM_DEPTH,
    SNAPSHOT_MAX_CHARS,
} from "./dom-snapshot.js";

export {
    clipCssValue,
    type CssDeclaration,
    cssInspect,
    CSS_MAX_RULES_DEFAULT,
    CSS_MAX_RULES_LIMIT,
    CSS_VALUE_CLIP,
    type CssRule,
    DEFAULT_CSS_PROPERTIES,
    type InheritedStyle,
    quadToRect,
    shapeComputed,
    shapeInherited,
    shapeMatchedRules,
} from "./css-inspect.js";

export {
    CONSOLE_LOGS_DEFAULT_LIMIT,
    CONSOLE_LOGS_MAX_LIMIT,
    consoleLogs,
} from "./console-logs.js";

export {
    NETWORK_LIST_ITEM_MAX_CHARS,
    NETWORK_LIST_MAX_ITEMS,
    NETWORK_REQUESTS_DEFAULT_LIMIT,
    NETWORK_REQUESTS_MAX_LIMIT,
    NETWORK_URL_CONTAINS_MAX_CHARS,
    NETWORK_URL_REGEX_MAX_CHARS,
    networkFilterOf,
    networkRequests,
} from "./network-requests.js";

export {
    RESPONSE_BODY_DEFAULT_CHARS,
    RESPONSE_BODY_MAX_CHARS,
    bodyByteSize,
    isTextMimeType,
    networkResponseBody,
} from "./network-response-body.js";

export {
    type ImageSize,
    imageSize,
    pngSize,
} from "./image-size.js";

export {
    PDF_A4_HEIGHT_INCHES,
    PDF_A4_WIDTH_INCHES,
    PDF_DEFAULT_MARGIN_INCHES,
    PDF_DEFAULT_MAX_BYTES,
    PDF_MAX_BYTES_LIMIT,
    PDF_PAGE_RANGES_MAX_CHARS,
    countPdfPages,
    pagePdf,
    validPageRanges,
} from "./page-pdf.js";

export {
    SCREENSHOT_DEFAULT_MAX_BYTES,
    SCREENSHOT_DEFAULT_MAX_DIMENSION,
    SCREENSHOT_DEFAULT_QUALITY,
    SCREENSHOT_MAX_BYTES_LIMIT,
    SCREENSHOT_RETRY_QUALITY,
    type ScreenshotClip,
    type ScreenshotFormat,
    type ScreenshotPlan,
    formatByteLimit,
    planScreenshot,
    retryQuality,
    roundClip,
    screenshot,
} from "./screenshot.js";

export {
    METRICS_TIMEOUT_MS,
    NAVIGATION_TIMING_EXPRESSION,
    pageMetrics,
    shapePerformanceMetrics,
} from "./page-metrics.js";

export { pageDetails, pageInfo, pageInfoExpression } from "./page-info.js";

export {
    elementFunctionDeclaration,
    EVALUATE_DEFAULT_RESULT_CHARS,
    EVALUATE_DEFAULT_TIMEOUT_MS,
    EVALUATE_MAX_EXPRESSION_CHARS,
    EVALUATE_MAX_RESULT_CHARS,
    EVALUATE_MAX_STACK_CHARS,
    EVALUATE_MAX_TIMEOUT_MS,
    exceptionText,
    formatExceptionStack,
    isBareEmptyObject,
    isFunctionExpression,
    jsEvaluate,
    shapeRemoteValue,
    type ShapedValue,
} from "./js-evaluate.js";

export {
    NAVIGATE_DEFAULT_TIMEOUT_MS,
    NAVIGATE_MAX_TIMEOUT_MS,
    type NavigationWaitEvent,
    type NavigationWaitState,
    navigationWaitReduce,
    navigationWaitStart,
    PAGE_STATE_EXPRESSION,
    pageNavigate,
    waitUntilSchema,
    type WaitUntil,
} from "./page-navigate.js";

export { closeTab, listSessions, listTabs, newTab, selectTab, selectionOf } from "./tabs.js";

export {
    boxOf,
    type ElementBox,
    type ElementNode,
    type ElementRef,
    ElementRegistry,
    type ElementTarget,
    elementTargetSchema,
    MAX_SELECTOR_LENGTH,
    MAX_UIDS_PER_TAB,
    type Rect,
    rectOfQuad,
    resolveElement,
    revealElement,
    STALE_UID_MESSAGE,
} from "./element-target.js";

export { FocusEmulation } from "./focus-emulation.js";

export { RingBuffer, type RingBufferOptions } from "./capture/ring-buffer.js";

export {
    CaptureManager,
    type CaptureManagerOptions,
    CONSOLE_BUFFER_BYTES,
    CONSOLE_BUFFER_ENTRIES,
    CONSOLE_EVENTS,
    type ConsoleQuery,
    NETWORK_BUFFER_BYTES,
    NETWORK_BUFFER_ENTRIES,
    NETWORK_EVENTS,
    type NetworkQuery,
} from "./capture/manager.js";

export {
    CONSOLE_ENTRY_CLIP_CHARS,
    CONSOLE_STACK_FRAMES,
    type ConsoleEntry,
    type ConsoleLevel,
    type ConsoleSource,
    clipConsoleText,
    formatConsoleArgument,
    formatConsoleStack,
    normalizeConsoleEvent,
} from "./capture/console-log.js";

export {
    NETWORK_REGEX_MAX_CHARS,
    NETWORK_URL_MATCH_CHARS,
    type NetworkFilter,
    type NetworkLookup,
    type NetworkRecord,
    type NetworkReduction,
    REDACTED,
    compileUrlPattern,
    matchNetworkRecord,
    redactHeaders,
    redactUrl,
    reduceNetworkEvent,
} from "./capture/network-log.js";

export {
    type ActionableElement,
    type ActionablePoint,
    type ActionabilityOptions,
    coveredMessage,
    describeTarget,
    type EditableKind,
    elementState,
    type ElementState,
    ensureActionable,
    HIT_EXPRESSION,
    type HitResult,
    type HitTarget,
    hitTest,
    readBox,
    STATE_EXPRESSION,
} from "./actionability.js";

export {
    centerOf,
    clickPointOf,
    type ClickPoint,
    type ElementOffset,
    type FrameOrigin,
    insideViewport,
    quadCenter,
    TOP_LEVEL_ORIGIN,
} from "./coordinates.js";

export {
    acceptedKeyNames,
    editingCommand,
    type KeyEventPlan,
    type KeyModifier,
    KEY_MODIFIERS,
    keyHints,
    type KeySpec,
    lookupKey,
    MODIFIER_BITS,
    modifiersMask,
    modifierSpec,
    type ParsedKey,
    parseKeyChord,
    planKeyPress,
    planTypedChar,
    producedText,
    resolveControlOrMeta,
} from "./keys.js";

export {
    changedUrl,
    click,
    CLICK_COUNT_MAX,
    CLICK_EXPRESSION,
    HOVER_DEFAULT_STEPS,
    HOVER_EXPRESSION,
    inputClick,
    inputHover,
    type MouseButton,
    MOUSE_BUTTON_BIT,
    navigationOf,
    positionSchema,
    summarizeTarget,
    targetSummarySchema,
    type TargetSummary,
} from "./input-click.js";

export {
    browserPlatform,
    clearPlatformCache,
    echoOf,
    inputKey,
    inputType,
    KEY_REPEAT_MAX,
    PLATFORM_EXPRESSION,
    platformCacheKey,
    TYPE_DELAY_MAX_MS,
    TYPE_ECHO_CHARS,
    TYPE_MAX_CHARS,
    VALUE_EXPRESSION,
} from "./input-text.js";

export {
    inputScroll,
    SCROLL_BLOCKS,
    SCROLL_DELTA_MAX,
    SCROLL_EDGES,
    type ScrollBlock,
    type ScrollEdge,
    SCROLL_INTO_VIEW_EXPRESSION,
    SCROLL_STATE_EXPRESSION,
    scrollMoved,
    type ScrollPosition,
    WHEEL_SETTLE_MS,
    wheelParams,
    type WheelScrollResult,
} from "./input-scroll.js";

export {
    describeOptions,
    inputSelect,
    matchSelectOptions,
    type SelectBy,
    type SelectOption,
    SELECT_OPTIONS_LIMIT,
    SELECT_READ_EXPRESSION,
    SELECT_WRITE_EXPRESSION,
} from "./input-select.js";

export {
    inputUpload,
    nodeUploadFs,
    UPLOAD_COUNT_EXPRESSION,
    UPLOAD_MAX_BYTES,
    UPLOAD_MAX_FILES,
    type UploadFileSystem,
    validateUploadFiles,
    type ValidatedUpload,
} from "./input-upload.js";

export {
    type DeviceEmulation,
    type LocaleEmulation,
    type NetworkEmulation,
    type TabEmulation,
    EmulationState,
} from "./emulation/state.js";

export {
    type DeviceKind,
    type DeviceSpec,
    type LandscapeSpec,
    asLandscape,
    DEVICE_HEIGHT_MAX,
    DEVICE_HEIGHT_MIN,
    DEVICE_SCALE_MAX,
    DEVICE_SCALE_MIN,
    DEVICE_USER_AGENT_MAX_CHARS,
    DEVICE_WIDTH_MAX,
    DEVICE_WIDTH_MIN,
    DEVICES,
    filterDevices,
    findDevice,
    suggestDevices,
} from "./emulation/devices.js";

export {
    BLOCK_URL_MAX_CHARS,
    BLOCK_URLS_MAX,
    type CdpCommand,
    type DeviceMetrics,
    type LocaleSelection,
    type MediaSelection,
    type MediaState,
    type NetworkConditions,
    type NetworkPresetName,
    type UserAgentParts,
    buildBlockedUrlsCommands,
    buildDeviceCommands,
    buildDeviceResetCommands,
    buildLocaleCommands,
    buildLocaleResetCommands,
    buildMediaCommands,
    buildMediaResetCommands,
    buildNetworkCommands,
    buildNetworkResetCommands,
    buildUserAgentCommand,
    canonicalLocale,
    checkedTimezone,
    deviceMetricsOf,
    mergeMedia,
    NETWORK_LATENCY_MAX_MS,
    NETWORK_PRESETS,
    NETWORK_THROUGHPUT_MAX_KBPS,
    orientationOf,
    presetConditions,
    resolveDevice,
    TOUCH_POINTS_DEFAULT,
} from "./emulation/commands.js";

export {
    type DeviceRead,
    type LocaleRead,
    type MediaRead,
    DEVICE_READ_EXPRESSION,
    EMULATION_READ_TIMEOUT_MS,
    LOCALE_READ_EXPRESSION,
    MEDIA_READ_EXPRESSION,
    readDevice,
    readLocale,
    readMedia,
} from "./emulation/reads.js";

export {
    type EmulationSummary,
    emulationSummarySchema,
    summarizeEmulation,
} from "./emulation/summary.js";

export { listDevices } from "./emulation/list-devices.js";

export {
    type DeviceInput,
    applyDeviceReset,
    checkDeviceInput,
    emulateDevice,
    explicitMetrics,
} from "./emulation/emulate-device.js";

export { emulateMedia, hasMediaSelection } from "./emulation/emulate-media.js";

export {
    type NetworkInput,
    checkNetworkInput,
    conditionsOf,
    emulateNetwork,
    ensureNetworkForEmulation,
} from "./emulation/emulate-network.js";

export {
    ACCEPT_LANGUAGE_MAX_CHARS,
    checkAcceptLanguage,
    emulateLocale,
    hasLocaleSelection,
} from "./emulation/emulate-locale.js";
