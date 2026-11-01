# chromium-devtools-mcp

MCP server that lets AI agents drive your real Chromium browser through the DevTools Protocol.

Status: early development. The core (config, browser connection, daemon, MCP entrypoint), the tab tools and the navigation and inspection tools work; the rest of the browser tools are not published yet.

## Features

- Works with the browser you already use, including your profile, bookmarks and logins, or with a separate persistent managed profile. Switchable in config.
- Tabs open in the background. Bringing a window to the front is refused unless `allowFocus` is on.
- Headless and interactive modes for the managed profile.
- Several MCP clients share one browser through a per-user daemon, each in its own session.
- Planned: the rest of the browser tools, one-command install into your MCP client, domain allowlist and confirmation of dangerous actions.

## Usage

```sh
npx -y chromium-devtools-mcp [options]          # MCP server on stdio
npx -y chromium-devtools-mcp daemon [options]   # browser daemon in the foreground
npx -y chromium-devtools-mcp --help
```

Until the installer exists, add the server to your client by hand. Most clients accept this entry:

```json
{
  "mcpServers": {
    "chromium-devtools": { "command": "npx", "args": ["-y", "chromium-devtools-mcp"] }
  }
}
```

Planned installer:

```sh
npx chromium-devtools-mcp install --client claude-code
```

Clients: Claude Code, Cherry Studio, Cursor, Codex.

## Attach mode setup

Attach mode controls the browser you already run. The browser has to allow it:

- A recent Chrome: open `chrome://inspect/#remote-debugging` and turn on remote debugging for this browser instance. Chrome may ask you to allow a connection; click Allow.
- Start Chrome with `--remote-debugging-port=<debugPort>`. Chrome 136 and newer ignore this flag on the default profile, so it also needs `--user-data-dir` pointing to another directory.

Until the browser allows it, the daemon prints these instructions, returns them to the client and keeps checking.

## Tools

Each session keeps its own tab selection. `new_tab` opens a background tab and selects it; the other tab tools act on the selected tab unless a `tab` id from `list_tabs` is passed. Claimed tabs cannot be closed, they are released when the session ends. When the daemon restarts, the session is gone and its tabs with it, so the tools say to open a new tab.

- `list_tabs`: list owned tabs, or with `scope: "available"` the browser tabs this session could claim.
- `list_sessions`: list open sessions of the daemon without their tab details.
- `select_tab`: select an owned tab, claiming an available one when needed. Never focuses it.
- `new_tab`: open a background tab and select it.
- `close_tab`: close a tab opened by this session.
- `page_info`: read the URL, title, viewport and scroll position of a tab.
- `page_navigate`: open a URL, go back or forward, or reload, waiting for the page to load.
- `js_evaluate`: run JavaScript in a tab. Page exceptions come back as data, not as tool errors.
- `dom_query`: find elements by a CSS selector and read their text, attributes and boxes.
- `dom_snapshot`: read a compact text snapshot of the page with element ids.
- `css_inspect`: read the computed style, matched CSS rules and box of an element.

Every tool returns its result as JSON text plus structured content. Large outputs are truncated with an explicit marker. Mutating tools (`new_tab`, `select_tab`, `close_tab`, `page_navigate`, `js_evaluate`) are refused in read-only mode; the domain allowlist and dangerous action confirmations are planned.

## Element ids

`dom_query` and `dom_snapshot` assign every element they report an id like `2_1`: the tab generation, then a counter. Pass the id as `{ "uid": "2_1" }` to target that element, or use `{ "selector": "..." }` with a CSS selector instead, never both. An id becomes stale when a new snapshot is taken or the tab navigates; using a stale id is an explicit error, never a wrong element.

## Output limits

Text results are capped per call: snapshots and evaluation results default to 50000 characters and can be raised to 200000 with `maxChars` or `maxResultChars`. The daemon protocol itself carries requests up to 1 MiB and responses up to 32 MiB. Elements hidden with `display: none` are absent from the accessibility tree, so snapshots never list them, even with `includeHidden`.

## Daemon

The MCP server connects to one daemon per user and data directory and starts it when it is absent. Clients that run with a different `HOME` or `XDG_DATA_HOME` get their own daemon. The daemon owns the browser connection and gives every MCP client its own session.

- It exits 30 seconds after its last client disconnects, also while it is still waiting for the browser.
- When it exits on idle, a managed browser with a window stays open and the next daemon reuses it. A headless managed browser is closed on idle, and any managed browser is closed when the daemon is stopped on request. Both apply only to a browser this daemon launched: a browser the daemon reused from an earlier run is only disconnected and keeps running.
- On Windows a managed browser is a child of the daemon and closes when the daemon exits, so it is not kept open on idle and is not reused after a daemon crash.
- Starting a managed browser with a window can briefly take the keyboard focus, because the operating system activates a new window. Everything the daemon does afterwards, such as opening, navigating and closing tabs, leaves the focus alone.
- Clients must agree on `browser`, `mode`, `debugPort` and `allowFocus`, and in managed mode also on `headless` and `profileDir`. A client with different settings gets an error that names the differing fields; stop the daemon or align the settings. `isolated` is per session and may differ between clients.
- On Windows the name of the daemon pipe derives from the token, so deleting `daemon.token` while a daemon runs makes the next client start a second daemon. Stop the daemon before removing the token.
- Its log is `daemon.log` in the data directory of the package: `~/Library/Application Support/chromium-devtools-mcp/daemon.log` on macOS, `~/.local/share/chromium-devtools-mcp/daemon.log` on Linux and `%LOCALAPPDATA%\chromium-devtools-mcp\daemon.log` on Windows. The access token `daemon.token` lives in the same directory and is readable only by you.
- Tabs can open only `http`, `https` and `about:blank` URLs.

## Configuration

Sources, from lowest to highest priority: built-in defaults, a JSON file, `CHROMIUM_DEVTOOLS_MCP_*` environment variables, command line flags.

The file is `~/.config/chromium-devtools-mcp/config.json` on macOS and Linux and `%APPDATA%\chromium-devtools-mcp\config.json` on Windows. Set `CHROMIUM_DEVTOOLS_MCP_CONFIG` to use another path. A missing file at the overridden path is an error, so a typo never silently drops your settings.

| Field                     | Flag                          | Env                                       | Values                                                                | Default         |
| ------------------------- | ----------------------------- | ----------------------------------------- | --------------------------------------------------------------------- | --------------- |
| `browser`                 | `--browser`                   | `CHROMIUM_DEVTOOLS_MCP_BROWSER`           | `chrome`, more browsers later                                         | `chrome`        |
| `mode`                    | `--mode`                      | `CHROMIUM_DEVTOOLS_MCP_MODE`              | `attach` (your running browser) or `managed` (own persistent profile) | `attach`        |
| `headless`                | `--headless`, `--no-headless` | `CHROMIUM_DEVTOOLS_MCP_HEADLESS`          | true or false, managed mode only                                      | false           |
| `profileDir`              | `--profile-dir`               | `CHROMIUM_DEVTOOLS_MCP_PROFILE_DIR`       | absolute directory of the managed profile                             | see below       |
| `debugPort`               | `--debug-port`                | `CHROMIUM_DEVTOOLS_MCP_DEBUG_PORT`        | 1 to 65535                                                            | 9222            |
| `allowFocus`              | `--allow-focus`               | `CHROMIUM_DEVTOOLS_MCP_ALLOW_FOCUS`       | allow bringing a window to the front                                  | false           |
| `isolated`                | `--isolated`, `--no-isolated` | `CHROMIUM_DEVTOOLS_MCP_ISOLATED`          | open the session in an isolated browser context                       | false           |
| `safety.readOnly`         | `--read-only`                 | `CHROMIUM_DEVTOOLS_MCP_READ_ONLY`         | refuse actions that change pages                                      | false           |
| `safety.allowedDomains`   | `--allowed-domains`           | `CHROMIUM_DEVTOOLS_MCP_ALLOWED_DOMAINS`   | comma separated list (planned)                                        | empty, no limit |
| `safety.confirmDangerous` | `--confirm-dangerous`         | `CHROMIUM_DEVTOOLS_MCP_CONFIRM_DANGEROUS` | ask before dangerous actions (planned)                                | false           |

The default `profileDir` is `~/Library/Application Support/chromium-devtools-mcp/profile` on macOS, `~/.local/share/chromium-devtools-mcp/profile` on Linux and `%LOCALAPPDATA%\chromium-devtools-mcp\profile` on Windows.

Boolean env values accept `true`, `1`, `false`, `0`, case-insensitively, with surrounding whitespace ignored. An empty or whitespace-only env value counts as unset. Every boolean flag also accepts a `--no-` form, for example `--no-read-only`.

On macOS and Linux `XDG_CONFIG_HOME` overrides the directory of the config file. On Linux `XDG_DATA_HOME` overrides the directory of the managed profile; on macOS the profile always lives under `~/Library/Application Support`. On Windows `APPDATA` and `LOCALAPPDATA` play the same roles. Empty or relative values of these variables are ignored.

An unknown flag, a missing value or a stray argument is an error, so a typo never silently changes the behavior.

## Supported

- Browsers: Chrome (macOS, Linux, Windows).
- OS: macOS, Linux, Windows.
- Transport: stdio.
- Node.js 22 or newer.

## Roadmap

1. Repository, npm name and CI.
2. Core: config, CDP client, browser discovery, managed and attach modes, daemon.
3. Tools: tabs (done), navigation and inspection (done), input, network, emulation, storage, dialogs, network mocking.
4. Safety controls (read-only mode works, the rest planned).
5. Client installer.
6. First release.
7. Later: performance traces and Core Web Vitals, Lighthouse, heap snapshots.

Detailed steps are in [docs/PLAN.md](docs/PLAN.md).

## License

MIT
