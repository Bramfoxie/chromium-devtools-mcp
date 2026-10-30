# chromium-devtools-mcp

MCP server that lets AI agents drive your real Chromium browser through the DevTools Protocol.

## Features

- Works with the browser you already use, including your profile, bookmarks and logins, or with a separate persistent managed profile. Switchable in config.
- Tabs open in the background. The window is brought to the front only on an explicit request.
- Headless and interactive modes.
- One-command install into your MCP client.
- Safety controls: read-only mode, domain allowlist, confirmation of dangerous actions.

## Install (planned)

```sh
npx chromium-devtools-mcp install --client claude-code
```

Clients: Claude Code, Cherry Studio, Cursor, Codex.

## Configuration

Sources, from lowest to highest priority: built-in defaults, a JSON file, `CHROMIUM_DEVTOOLS_MCP_*` environment variables, command line flags.

The file is `~/.config/chromium-devtools-mcp/config.json` on macOS and Linux and `%APPDATA%\chromium-devtools-mcp\config.json` on Windows. Set `CHROMIUM_DEVTOOLS_MCP_CONFIG` to use another path.

| Field                     | Flag                          | Values                                                                |
| ------------------------- | ----------------------------- | --------------------------------------------------------------------- |
| `browser`                 | `--browser`                   | `chrome` or `arc`                                                     |
| `mode`                    | `--mode`                      | `attach` (your running browser) or `managed` (own persistent profile) |
| `headless`                | `--headless`, `--no-headless` | true or false                                                         |
| `profileDir`              | `--profile-dir`               | directory of the managed profile                                      |
| `debugPort`               | `--debug-port`                | 1 to 65535                                                            |
| `allowFocus`              | `--allow-focus`               | allow bringing a window to the front, off by default                  |
| `safety.readOnly`         | `--read-only`                 | refuse actions that change pages                                      |
| `safety.allowedDomains`   | `--allowed-domains`           | comma separated list                                                  |
| `safety.confirmDangerous` | `--confirm-dangerous`         | ask before dangerous actions                                          |

An unknown flag, a missing value or a stray argument is an error, so a typo never silently changes the behavior.

## Supported

- Browsers: Chrome, Arc.
- OS: macOS, Linux, Windows.
- Transport: stdio.
- Node.js 22 or newer.

## Roadmap

1. Repository, npm name and CI.
2. Core: config, CDP client, browser discovery, managed and attach modes, daemon.
3. Tools: tabs, navigation, DOM, input, network, emulation, storage, dialogs, network mocking.
4. Safety controls.
5. Client installer.
6. First release.
7. Later: performance traces and Core Web Vitals, Lighthouse, heap snapshots.

Detailed steps are in [docs/PLAN.md](docs/PLAN.md).

## License

MIT
