import { ConfigError } from "../config/index.js";
import type { AnyTool } from "./define-tool.js";

export const TOOL_GROUPS: Readonly<Record<string, readonly string[]>> = {
    tabs      : ["window_list", "popup_list", "list_tabs", "list_sessions", "select_tab", "new_tab", "close_tab", "bring_to_front"],
    pages     : ["page_info", "page_navigate", "page_wait", "page_dialogs", "page_metrics", "page_pdf"],
    inspection: [
        "dom_query",
        "dom_snapshot",
        "a11y_snapshot",
        "dom_selector",
        "dom_edit",
        "css_inspect",
        "event_listeners",
        "css_edit",
        "js_evaluate",
        "screenshot",
    ],
    input: [
        "click",
        "input_click",
        "input_hover",
        "input_drag",
        "input_type",
        "input_key",
        "input_scroll",
        "input_select",
        "input_upload",
        "fill_form",
    ],
    performance: [
        "perf_trace_start",
        "perf_trace_stop",
        "heap_snapshot",
        "screencast_start",
        "screencast_stop",
        "lighthouse_audit",
    ],
    observation: ["console_logs", "network_requests", "network_har", "network_response_body"],
    network    : ["network_mock"],
    storage    : ["storage_read", "storage_write", "downloads"],
    webauth    : ["webauthn"],
    webapps    : ["pwa_info"],
    emulation  : [
        "list_devices",
        "emulate_device",
        "emulate_media",
        "emulate_network",
        "emulate_locale",
        "emulate_geolocation",
    ],
    slim: [
        "list_tabs",
        "select_tab",
        "new_tab",
        "close_tab",
        "page_info",
        "page_navigate",
        "page_wait",
        "dom_snapshot",
        "dom_query",
        "screenshot",
        "click",
        "input_type",
        "input_key",
        "input_select",
        "fill_form",
        "console_logs",
        "network_requests",
    ],
};

export interface ToolSelection {
    tools?       : readonly string[] | undefined;
    excludeTools?: readonly string[] | undefined;
}

function expand(entries: readonly string[], names: ReadonlySet<string>): Set<string> {
    const found = new Set<string>();

    for (const entry of entries) {
        const group = TOOL_GROUPS[entry];

        if (group !== undefined) {
            for (const name of group) if (names.has(name)) found.add(name);
        } else if (names.has(entry)) {
            found.add(entry);
        } else {
            throw new ConfigError(
                `unknown tool or group ${JSON.stringify(entry)}, tools: ${[...names].join(", ")}; groups: ${Object.keys(TOOL_GROUPS).join(", ")}`,
            );
        }
    }

    return found;
}

// Names and groups are checked against the tools that exist, so a typo cannot silently keep a tool on.
export function selectTools(all: readonly AnyTool[], selection: ToolSelection): AnyTool[] {
    const names = new Set(all.map((tool) => tool.name));
    const wanted = selection.tools === undefined || selection.tools.length === 0
        ? names
        : expand(selection.tools, names);
    const removed = expand(selection.excludeTools ?? [], names);
    const chosen = all.filter((tool) => wanted.has(tool.name) && !removed.has(tool.name));

    if (chosen.length === 0) {
        throw new ConfigError("no tool is left after applying tools and excludeTools");
    }

    return chosen;
}
