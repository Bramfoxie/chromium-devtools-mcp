# chromium-devtools-mcp

[![CI](https://github.com/Bramfoxie/chromium-devtools-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Bramfoxie/chromium-devtools-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/chromium-devtools-mcp)](https://www.npmjs.com/package/chromium-devtools-mcp)
[![license](https://img.shields.io/npm/l/chromium-devtools-mcp)](LICENSE)

An MCP server that lets AI agents drive Chrome through the DevTools Protocol, either your running browser or a managed profile, without stealing focus.

## Why

- Works with the browser you already use (attach) or with a persistent managed profile. No bundled browser, no fresh profile per run.
- One per-user daemon serves several MCP clients at once, each in its own session, optionally in an isolated browser context.
- Never steals focus: tabs open in the background and input does not raise windows. `bring_to_front` exists for the moment you ask to see a tab and works only with `allowFocus` on.
- Reaches into shadow DOM and cross-site iframes from every element tool.
- Performance traces, Core Web Vitals, heap snapshots, screen recording, Lighthouse audits, passkey testing and location emulation, each for the tab you point it at.
- Safety options for agents: read-only mode, domain allowlist, confirmation of dangerous actions.

## Quick start

```sh
npx chromium-devtools-mcp install --client claude-code
```

`--client` takes `claude-code`, `cursor`, `codex`, `cherry-studio` or `all`. Restart the client afterwards. Any other client that accepts a JSON `mcpServers` entry can use:

```json
{
  "mcpServers": {
    "chromium-devtools": { "command": "npx", "args": ["-y", "chromium-devtools-mcp"] }
  }
}
```

First run:

- attach (default): the server connects to your running Chrome. If Chrome does not allow it yet, the server prints how to enable remote debugging at `chrome://inspect/#remote-debugging` and keeps waiting. It never falls back to another profile.
- managed: pass `--mode managed`. The server launches Chrome with its own persistent profile, headed or with `--headless`.

If something does not connect, run `npx chromium-devtools-mcp doctor` (add the same flags as in your client entry). It checks the setup and prints how to fix what it finds. On macOS, when Chrome has remote debugging on but the client app that starts the server (Cherry Studio, Orca and similar) may not read Chrome's `DevToolsActivePort` file, the server and `doctor` say so and do not report that debugging is off; the fix is Full Disk Access for that app in System Settings, or starting `npx chromium-devtools-mcp daemon` once in a terminal that has access. `chromium-devtools-mcp config` (with the same flags) prints the effective configuration and which source set each value, and validates the config file. `daemon status`, `daemon stop` and `daemon logs` show and control the background daemon, see [docs/daemon.md](docs/daemon.md).

## Compared with the official Chrome DevTools MCP

✅ means the project has the capability, ❌ means it has none.

| Capability                                                                 | chromium-devtools-mcp | Chrome DevTools MCP |
| -------------------------------------------------------------------------- | :-------------------: | :-----------------: |
| One shared daemon, isolated sessions for several clients                   |          ✅           |         ❌          |
| Focus never stolen, tabs open in the background                            |          ✅           |         ❌          |
| Trusted input events (CDP) and DOM-level click as separate tools           |          ✅           |         ❌          |
| Shadow DOM and cross-site iframe piercing in every element tool            |          ✅           |         ❌          |
| Network mocking and failing requests                                       |          ✅           |         ❌          |
| Network records with redaction of secrets in URLs and headers              |          ✅           |         ❌          |
| Storage read and write (local, session, cookies)                           |          ✅           |         ❌          |
| PDF export                                                                 |          ✅           |         ❌          |
| Built-in device list, locale, timezone, media, network emulation           |          ✅           |         ❌          |
| Read-only mode, allow and deny lists, private network block, confirmations |          ✅           |         ❌          |
| DOM and CSS editing without JavaScript, previous value returned            |          ✅           |         ❌          |
| Locators by role, name or text, with auto-wait before input                |          ✅           |         ❌          |
| HAR 1.2 export of network records                                          |          ✅           |         ❌          |
| Audit log of every tool call with secrets redacted                         |          ✅           |         ❌          |
| Choose the offered tools by name or group                                  |          ✅           |         ❌          |
| Installer for several clients                                              |          ✅           |         ❌          |
| Attach to your running browser                                             |          ✅           |         ✅          |
| Managed persistent profile                                                 |          ✅           |         ✅          |
| Isolated browser context per session                                       |          ✅           |         ✅          |
| Performance traces and insights                                            |          ✅           |         ✅          |
| Lighthouse audit                                                           |          ✅           |         ✅          |
| Heap snapshots                                                             |          ✅           |         ✅          |
| Screencast recording                                                       |          ✅           |         ✅          |
| WebAuthn virtual authenticators                                            |          ✅           |         ✅          |
| PWA inspection (manifest, installability, service workers)                 |          ✅           |         ✅          |
| Geolocation emulation                                                      |          ✅           |         ✅          |
| PWA install and extension management                                       |          ❌           |         ✅          |
| Browsers other than Chrome                                                 |          ❌           |         ❌          |

Lighthouse audits and the video of a screencast use the `lighthouse` and `ffmpeg` programs when they are installed on your machine; `doctor` shows whether they are.

Compared against Chrome DevTools MCP 1.12.0 (2026-10-22, [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)). A cross on its side means its tool reference lists no tool for that capability. Version 0.2.0 of this project supports Chrome only.

## Tools

56 tools. Details and parameters are in [docs/tools.md](docs/tools.md).

| Category    | Tools                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs        | `list_tabs`, `popup_list`, `window_list`, `list_sessions`, `select_tab`, `new_tab`, `close_tab`, `bring_to_front`                                   |
| Pages       | `page_info`, `page_navigate`, `page_wait`, `page_dialogs`, `page_metrics`, `page_pdf`                                                               |
| Inspection  | `dom_query`, `dom_snapshot`, `a11y_snapshot`, `dom_selector`, `dom_edit`, `css_inspect`, `event_listeners`, `css_edit`, `js_evaluate`, `screenshot` |
| Input       | `click`, `input_click`, `input_hover`, `input_drag`, `input_type`, `input_key`, `input_scroll`, `input_select`, `input_upload`, `fill_form`         |
| Performance | `perf_trace_start`, `perf_trace_stop`, `heap_snapshot`, `screencast_start`, `screencast_stop`, `lighthouse_audit`                                   |
| Observation | `console_logs`, `network_requests`, `network_har`, `network_response_body`                                                                          |
| Network     | `network_mock`                                                                                                                                      |
| Storage     | `storage_read`, `storage_write`, `downloads`                                                                                                        |
| Web auth    | `webauthn`                                                                                                                                          |
| Web apps    | `pwa_info`                                                                                                                                          |
| Emulation   | `list_devices`, `emulate_device`, `emulate_media`, `emulate_network`, `emulate_locale`, `emulate_geolocation`                                       |

## Resources

The tabs of your session are also MCP resources, for clients that attach resources to a conversation: `browser://tab/<tab id>/text` (the visible text with the address and title), `browser://tab/<tab id>/screenshot` (a PNG of the visible area) and `browser://tab/<tab id>/console` (console messages and exceptions). The list follows the tabs the session owns. Text and console are marked as untrusted page content like tool results. Details: [docs/tools.md](docs/tools.md).

## Safety

- `safety.readOnly` refuses every tool that changes page or browser state.
- `safety.allowedDomains` limits where mutating tools may act; redirects are checked too.
- `safety.deniedDomains` blocks hosts for mutating tools and navigation, and wins over the allow list.
- `safety.allowPrivateNetworks` is off by default: `new_tab` and `page_navigate` refuse local and private network addresses (`localhost`, `192.168.x.x`, `169.254.169.254` and similar), also after a redirect. A host named in `safety.allowedDomains` is still opened.
- Tool results that can carry page content start with an `untrusted` notice that tells the model to treat the values as data, not as instructions. Page text stays inside quoted JSON strings, so it cannot close the notice.
- `safety.confirmDangerous` asks the user through MCP elicitation before scripts, storage writes, cookie reads, file uploads, location emulation, heap snapshots that are saved and DOM edits that replace HTML or remove an element.

The daemon enforces these per session. Limits and exact rules: [docs/safety.md](docs/safety.md).

## Configuration

Sources from lowest to highest priority: defaults, JSON file, `CHROMIUM_DEVTOOLS_MCP_*` environment variables, command line flags.

| Field                         | Flag                       | Default                 |
| ----------------------------- | -------------------------- | ----------------------- |
| `browser`                     | `--browser`                | `chrome`                |
| `mode`                        | `--mode`                   | `attach`                |
| `headless`                    | `--headless`               | false                   |
| `profileDir`                  | `--profile-dir`            | per-user data directory |
| `debugPort`                   | `--debug-port`             | 0 managed, 9222 attach  |
| `wsEndpoint`                  | `--ws-endpoint`            | unset, attach only      |
| `allowFocus`                  | `--allow-focus`            | false                   |
| `isolated`                    | `--isolated`               | false                   |
| `safety.readOnly`             | `--read-only`              | false                   |
| `safety.allowedDomains`       | `--allowed-domains`        | empty, no limit         |
| `safety.deniedDomains`        | `--denied-domains`         | empty                   |
| `safety.allowPrivateNetworks` | `--allow-private-networks` | false                   |
| `safety.confirmDangerous`     | `--confirm-dangerous`      | false                   |

Env names, file paths and rules: [docs/configuration.md](docs/configuration.md).

## Supported

- Browser: Chrome.
- OS: macOS, Linux, Windows.
- Node.js 24 or newer. Transport: stdio.

## Documentation

- [Tools](docs/tools.md)
- [Configuration](docs/configuration.md)
- [Safety](docs/safety.md)
- [Shadow DOM, frames and element ids](docs/frames-and-shadow-dom.md)
- [Output limits](docs/output-limits.md)
- [Daemon and sessions](docs/daemon.md)
- [Installer](docs/install.md)
- [Contributing](CONTRIBUTING.md), [security policy](SECURITY.md) and [code of conduct](CODE_OF_CONDUCT.md)

Wheel scrolling can experimentally observe a trusted event in the document under the point; an unconfirmed observation does not mean the event was not delivered. See [tool details](docs/tools.md).

## License

[MIT](LICENSE)
