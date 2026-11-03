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

If something does not connect, run `npx chromium-devtools-mcp doctor` (add the same flags as in your client entry). It checks the setup and prints how to fix what it finds. `daemon status`, `daemon stop` and `daemon logs` show and control the background daemon, see [docs/daemon.md](docs/daemon.md).

## Compared with the official Chrome DevTools MCP

| Capability                                                          | chromium-devtools-mcp | Chrome DevTools MCP |
| ------------------------------------------------------------------- | :-------------------: | :-----------------: |
| Attach to your running browser                                      |          ✅           |         ✅          |
| Managed persistent profile                                          |          ✅           |         ✅          |
| Isolated browser context per session                                |          ✅           |         ✅          |
| One shared daemon, isolated sessions for several clients            |          ✅           |         ❌          |
| Focus never stolen, tabs open in the background                     |          ✅           |         ❌          |
| Trusted input events (CDP) and DOM-level click as separate tools    |          ✅           |         ❌          |
| Shadow DOM and cross-site iframe piercing in every element tool     |          ✅           |         ❌          |
| Network mocking and failing requests                                |          ✅           |         ❌          |
| Network records with redaction of secrets in URLs and headers       |          ✅           |         ❌          |
| Storage read and write (local, session, cookies)                    |          ✅           |         ❌          |
| PDF export                                                          |          ✅           |         ❌          |
| Built-in device list, locale, timezone, media, network emulation    |          ✅           |         ❌          |
| Read-only mode, domain allowlist, confirmation of dangerous actions |          ✅           |         ❌          |
| Installer for several clients                                       |          ✅           |         ❌          |
| Browsers other than Chrome                                          |          ❌           |         ❌          |
| Performance traces and insights                                     |          ❌           |         ✅          |
| Lighthouse audit                                                    |          ❌           |         ✅          |
| Heap snapshots                                                      |          ❌           |         ✅          |
| Screencast recording                                                |          ❌           |         ✅          |
| Extensions, PWA and WebAuthn tools                                  |          ❌           |         ✅          |
| Geolocation emulation                                               |          ❌           |         ✅          |

Compared against Chrome DevTools MCP 1.12.0 (2026-10-22, [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)). A cross on its side means its tool reference lists no tool for that capability. Version 0.1.0 of this project supports Chrome only.

## Tools

37 tools. Details and parameters are in [docs/tools.md](docs/tools.md).

| Category    | Tools                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Tabs        | `list_tabs`, `list_sessions`, `select_tab`, `new_tab`, `close_tab`, `bring_to_front`                                          |
| Pages       | `page_info`, `page_navigate`, `page_wait`, `page_dialogs`, `page_metrics`, `page_pdf`                                         |
| Inspection  | `dom_query`, `dom_snapshot`, `css_inspect`, `js_evaluate`, `screenshot`                                                       |
| Input       | `click`, `input_click`, `input_hover`, `input_type`, `input_key`, `input_scroll`, `input_select`, `input_upload`, `fill_form` |
| Observation | `console_logs`, `network_requests`, `network_response_body`                                                                   |
| Network     | `network_mock`                                                                                                                |
| Storage     | `storage_read`, `storage_write`                                                                                               |
| Emulation   | `list_devices`, `emulate_device`, `emulate_media`, `emulate_network`, `emulate_locale`                                        |

## Safety

- `safety.readOnly` refuses every tool that changes page or browser state.
- `safety.allowedDomains` limits where mutating tools may act; redirects are checked too.
- `safety.confirmDangerous` asks the user through MCP elicitation before scripts, storage writes, cookie reads and file uploads.

The daemon enforces these per session. Limits and exact rules: [docs/safety.md](docs/safety.md).

## Configuration

Sources from lowest to highest priority: defaults, JSON file, `CHROMIUM_DEVTOOLS_MCP_*` environment variables, command line flags.

| Field                     | Flag                  | Default                 |
| ------------------------- | --------------------- | ----------------------- |
| `browser`                 | `--browser`           | `chrome`                |
| `mode`                    | `--mode`              | `attach`                |
| `headless`                | `--headless`          | false                   |
| `profileDir`              | `--profile-dir`       | per-user data directory |
| `debugPort`               | `--debug-port`        | 0 managed, 9222 attach  |
| `wsEndpoint`              | `--ws-endpoint`       | unset, attach only      |
| `allowFocus`              | `--allow-focus`       | false                   |
| `isolated`                | `--isolated`          | false                   |
| `safety.readOnly`         | `--read-only`         | false                   |
| `safety.allowedDomains`   | `--allowed-domains`   | empty, no limit         |
| `safety.confirmDangerous` | `--confirm-dangerous` | false                   |

Env names, file paths and rules: [docs/configuration.md](docs/configuration.md).

## Supported

- Browser: Chrome.
- OS: macOS, Linux, Windows.
- Node.js 22 or newer. Transport: stdio.

## Documentation

- [Tools](docs/tools.md)
- [Configuration](docs/configuration.md)
- [Safety](docs/safety.md)
- [Shadow DOM, frames and element ids](docs/frames-and-shadow-dom.md)
- [Output limits](docs/output-limits.md)
- [Daemon and sessions](docs/daemon.md)
- [Installer](docs/install.md)
- [Contributing](CONTRIBUTING.md), [security policy](SECURITY.md) and [code of conduct](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE)
