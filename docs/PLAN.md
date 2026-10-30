# Plan

Each step is a separate commit.

## 0. Repository

1. Add .gitignore and git hooks.
2. Add README.
3. Scaffold package: package.json, tsconfig, eslint, prettier, vitest, `prepare` script that sets core.hooksPath.
4. Add GitHub Actions: lint, typecheck, unit tests on Linux, macOS, Windows.

## 1. Core

5. Config loader: file, env and CLI overrides, schema validation.
6. CDP client: WebSocket transport, request/response, events, sessions.
7. Browser discovery for Chrome and Arc on all three OS.
8. Managed mode: persistent profile launch, headless flag.
9. Attach mode: connect to the running browser, detect disabled remote debugging, print instructions, wait and retry.
10. Daemon: single instance lock, local IPC, client sessions, isolated contexts.
11. MCP entrypoint: stdio server that connects to or starts the daemon.

## 2. Tools (v1)

12. Tabs: list_tabs, list_sessions, select_tab, new_tab, close_tab, page_info.
13. Navigation and inspection: page_navigate, js_evaluate, dom_query, dom_snapshot with uid, css_inspect.
14. Input: click, input_click, input_hover, input_type, input_key, input_scroll, input_select, input_upload.
15. Observation: console_logs, network_requests, network_response_body, screenshot, page_pdf, page_metrics.
16. Emulation: list_devices, emulate_device, emulate_media, emulate_network, emulate_locale.
17. Control: page_wait, page_dialogs, storage_read, storage_write, network_mock.
18. Shadow DOM and iframe piercing across DOM tools.

## 3. Safety

19. Read-only mode, domain allowlist, confirmation of dangerous actions.

## 4. Installer

20. `install` command for Claude Code, Cherry Studio, Cursor, Codex.

## 5. Release

21. Integration tests with a real browser in CI.
22. npm publish workflow on tag.

## Later

- Performance traces, Core Web Vitals, Lighthouse.
- Heap snapshots.
- Plugin system, if a concrete need appears.
