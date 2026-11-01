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
