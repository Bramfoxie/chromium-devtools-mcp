# chromium-devtools-mcp

MCP server that lets AI agents drive your real Chromium browser through the DevTools Protocol.

Status: early development. The core (config, browser connection, daemon, MCP entrypoint) and all planned browser tools work. The domain allowlist, confirmation of dangerous actions and the client installer are not implemented yet; read-only mode works.

## Features

- Works with the browser you already use, including your profile, bookmarks and logins, or with a separate persistent managed profile. Switchable in config.
- Tabs open in the background. Bringing a window to the front is refused unless `allowFocus` is on.
- Headless and interactive modes for the managed profile.
- Several MCP clients share one browser through a per-user daemon, each in its own session.
- Planned: one-command install into your MCP client, domain allowlist and confirmation of dangerous actions.

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
- `list_sessions`: list open sessions of the daemon without their tab details. Each session shows the client name the MCP client sent in its initialize request, or `chromium-devtools-mcp` when it sent none.
- `select_tab`: select an owned tab, claiming an available one when needed. Never focuses it.
- `new_tab`: open a background tab and select it. With a `url` it waits for the page to commit and load, for at most `timeoutMs` (default 30000), and returns the committed `url` and `title`, `waited` (`load`, `timeout` or `none`), the document `readyState` and the HTTP `status` when observed. A download, an empty 204 response or a network error does not fail the call: the tab stays open, on `about:blank` for a download or a 204 and on the browser error page for a network error, and `navigationError` says why. The tab is never brought to the front.
- `close_tab`: close a tab opened by this session.
- `page_info`: read the URL, title, viewport, scroll position and emulation state of a tab.
- `page_navigate`: open a URL, go back or forward, or reload, waiting for the page to load.
- `js_evaluate`: run JavaScript in a tab. Page exceptions come back as data, not as tool errors. The exception text and the value are cut at `maxResultChars` with a marker; a value that cannot be serialized within the 32 MiB protocol limit is reported as its description with `truncated: true`.
- `dom_query`: find elements by a CSS selector and read their text, attributes and boxes.
- `dom_snapshot`: read a compact text snapshot of the page with element ids.
- `css_inspect`: read the computed style, matched CSS rules and box of an element. The result carries `totalRules`, `truncated` and `droppedWinners`, the properties whose winning declaration is in a rule that `maxRules` dropped.
- `click`: click an element at the DOM level with `element.click()` semantics. Works on covered elements and background tabs; the event is not trusted.
- `input_click`: click with trusted CDP mouse events, like a real user. Refuses a covered element unless `force` is passed.
- `input_hover`: hover an element with trusted CDP mouse events, so hover styles and menus react.
- `input_type`: type text into a field, with `clear` and `submit` options. Passwords are typed but never echoed back.
- `input_key`: press a key or chord like `Enter` or `ControlOrMeta+C`. `ControlOrMeta` resolves from the browser platform. On macOS, Control combined with a letter does not trigger editing commands such as select all; use `Meta+A` or `ControlOrMeta+A` there.
- `input_scroll`: scroll by wheel deltas, to the top or bottom, or an element into view. Reports honestly when the wheel left the window position unchanged.
- `input_select`: choose options of a `select` by value, label or index.
- `input_upload`: attach local files to a file input. This is the most sensitive tool: it sends local files to a web page. Paths are validated on the server machine (absolute, existing regular readable files under 100 MiB, at most 20), symlinks are followed, and results carry file names and sizes only, never contents.
- `console_logs`: read console messages, uncaught exceptions and browser messages of a tab, with level and text filters, paging and clear.
- `network_requests`: read HTTP requests of a tab with URL, method, resource type, status and failure filters.
- `network_response_body`: read the response body of a request from `network_requests`. Binary bodies need `asBase64`; without it the result has `needsBase64: true` and no body. `maxChars` defaults to 50000 and allows up to 500000; a base64 body is cut at a multiple of 4 characters and always keeps at least 4. Bodies over the 32 MiB transport limit are refused. Redirect responses have no body.
- `network_mock`: mock responses or fail requests by Fetch wildcard pattern, with delay and a use count. First match in insertion order wins.
- `page_dialogs`: see and resolve JavaScript dialogs, or set an automatic accept or dismiss policy for later ones.
- `page_wait`: wait for a selector, text, URL, load state or expression. A timeout returns `met: false`, not an error.
- `storage_read`: read local storage, session storage or cookies of the page origin. Cookie values are secrets and stay hidden unless `includeValues` is true.
- `storage_write`: write local storage, session storage or cookies of the page origin. Cookie domains must match the page host. `clear` needs `confirm: true`.
- `page_pdf`: print a tab to PDF with orientation, paper, margins and page ranges. Needs a headless managed browser when the headed browser refuses to print. The PDF defaults to 8 MiB and `maxBytes` raises that to 24 MiB; a larger PDF is refused with a hint to use `pageRanges`.
- `page_metrics`: read performance counters, layout metrics and navigation timing of a tab.
- `screenshot`: capture a tab as an image. Defaults to jpeg quality 80; supports viewport, full page, element and clip shots.
- `list_devices`: list the built in devices for `emulate_device`, with an optional name or kind filter.
- `emulate_device`: emulate a device size, pixel ratio, mobile viewport, touch and user agent. The Chrome version in the user agent of a desktop or Android device follows the connected browser. Client hints metadata is not emulated.
- `emulate_media`: emulate a media type and media features such as color scheme and reduced motion. Only the given fields change, and reset: true cannot be combined with other fields.
- `emulate_network`: emulate network conditions with a preset (offline, slow-3g, fast-3g, 4g, wifi, none), custom latency and throughput (a throughput of 0 is rejected, use -1 to remove the limit), or blocked URL patterns. The none preset also clears blocked URLs, and reset: true cannot be combined with other fields. Shares `Network.enable` with the capture tools and never disables capture.
- `emulate_locale`: emulate locale, timezone and Accept-Language. Takes effect on the next page load: `navigator.language` changes after navigation, and number and date formatting follow the locale. Geolocation is not emulated: it needs the Browser domain, which is not reachable through a tab.

Tool annotations follow the MCP meaning: `readOnlyHint` is false for mutating tools, and `openWorldHint` is true for every tool that reads or acts on web pages and false for the tools that only manage sessions, tabs, device lists, emulation settings and dialogs. Every tool returns its result as JSON text plus structured content. Large outputs are truncated with an explicit marker. `screenshot` and `page_pdf` also return an image or embedded resource block. Mutating tools (`new_tab`, `select_tab`, `close_tab`, `page_navigate`, `js_evaluate`, `click`, `input_click`, `input_hover`, `input_type`, `input_key`, `input_scroll`, `input_select`, `input_upload`, `emulate_device`, `emulate_media`, `emulate_network`, `emulate_locale`, `storage_write`) are refused in read-only mode, and so are `screenshot` calls with a `target`, `network_mock` actions other than `list` and `page_dialogs` actions other than `status` or with a policy; the domain allowlist and dangerous action confirmations are planned.

Each emulation tool returns the full emulation state of the tab, plus what the page reports (viewport, media queries, language) when the page answers. `reset: true` removes only the overrides of that tool. Overrides live in the tab session and are gone when the tab closes or the session resets. Device emulation reports the inner size the page sees: without a viewport meta tag a mobile page keeps its default 980 CSS pixel layout width.

Input tools never bring the browser window to the front. The page believes it is focused through CDP focus emulation, enabled once per tab, so mouse and keyboard events behave like a real user while your windows stay put.

Dialog capture starts when a tab is created or selected: while a dialog is open, tools that run page scripts fail fast and name `page_dialogs` instead of timing out. The dialog policy auto-resolves later dialogs including `beforeunload` and is cleared on reset. A dialog that was already open before the tab was first created or selected cannot be observed, so `page_dialogs` cannot see or resolve it: the browser does not answer Page.enable while it is open, so the first call fails after 3 seconds with a message to resolve the dialog in the browser.

Storage tools only touch the page origin. Cookie reads never leave the page URL: no `urls` parameter is sent and `Network.getAllCookies` is never used. Cookie writes always carry the page URL, and the domain must equal the page host or be its parent domain. Values are never logged; cookie values are only returned with `includeValues: true`.

Mock rules live per tab in the MCP process: at most 100 rules, bodies up to 10 MiB each and 64 MiB in total, delays up to 30 seconds. Requests that match no rule continue untouched. Rules survive navigation and are removed on tab close, session reset and `clear`. A `times` limit expires the rule after that many applications.

## Element ids

`dom_query` and `dom_snapshot` assign every element they report an id like `2_1`: the tab generation, then a counter. Pass the id as `{ "uid": "2_1" }` to target that element, or use `{ "selector": "..." }` with a CSS selector instead, never both. An id becomes stale when a new snapshot is taken or the tab navigates; using a stale id is an explicit error, never a wrong element.

## Shadow DOM and iframes

Every element target accepts `pierce` and `frame` next to `selector`. Plain selectors keep their browser meaning: they match only the light DOM of the main frame. `pierce: true` matches through open shadow roots anywhere in the frame. A `>>>` chain such as `my-app >>> #inner-button` scopes each segment inside the shadow root of the previous match and also crosses closed shadow roots; pass `pierce` or a chain, not both. `frame` scopes the selector to a frame: pass a frame id from `dom_snapshot` or a CSS selector of an `iframe` element in the main document. A selector that matches more than one iframe is an error that lists each candidate with its index, id, name, URL and frame id; pass the frame id from `dom_snapshot` then. `dom_query` and `page_wait` selector conditions take the same `pierce` and `frame` fields, except that the `frame` of `page_wait` accepts only a frame id, not an iframe selector. `dom_query` reports `total` as the number of selector matches found and sets `truncated` when the `text` filter looked at only the first 2000 matches, a `pierce` search returned only the first 200, or a `pierce` walk stopped after visiting 20000 elements. A `page_wait` selector condition with `pierce` visits at most 20000 elements and reports `capped: true` in `detail` when it stopped early.

`dom_snapshot` renders the composed tree: shadow content appears inline, and every iframe shows as `[uid] iframe "name" frame=<id>` with its content as a following section; the content of a cross-site frame is read from its own session with the same caps. The `frames` array of the result lists every frame with its parent, URL, `isolated` flag (true when the frame runs in its own process) and node count. At most `maxFrames` frame contents are included (default 20, maximum 50); frames beyond the limit are listed with `omitted: true`. `dom_snapshot` reads the DOM to 10 levels and the accessibility tree to 50 levels and 20000 nodes (the same node cap applies to each frame section); when a cap applies the text ends with a `[truncated: ...]` marker and `truncated` is true. Element ids inside a frame go stale when that frame navigates or is removed, while ids of other frames keep working.

Clicks and typing work the same across boundaries: boxes are viewport coordinates, trusted mouse events are dispatched at the top level, and the hit test descends through frames and shadow roots. Cross-site frames run in their own process and are listed with `isolated: true`. Every tool that takes an element target works in them, by frame id, by iframe selector or by uid: `dom_query`, `dom_snapshot` (as `root` too), `css_inspect`, `js_evaluate` with `target`, `screenshot` with `target`, `click`, `input_click`, `input_hover`, `input_scroll`, `input_select`, `input_upload`, `input_type` and `input_key`. Element work such as styles, scripting, focus, option selection and file attachment runs on the session that owns the frame, while trusted mouse, wheel and key events go through the tab, which Chrome routes into the frame. For `input_click`, `input_hover`, `screenshot` and the `css_inspect` box, a box measured in the frame is translated to page coordinates through the position and scale of each iframe element, nested frames included; the iframes are scrolled into view first, and the click hit test runs in the frame and then in each parent frame, so an element of the parent page that covers the iframe is reported. `input_scroll` with a target scrolls the element into view inside its frame, then scrolls the iframes into view in the page, and reports the scroll position of the frame. Sandboxed iframes without `allow-same-origin` expose no document to the debugger and cannot be queried; nested, scrolled, zero-size and `srcdoc` frames work. Frames nested inside a cross-site frame are served by the same session and get their own `dom_snapshot` sections and page coordinates.

## Output limits

Text results are capped per call: snapshots and evaluation results default to 50000 characters and can be raised to 200000 with `maxChars` or `maxResultChars`. The daemon protocol itself carries requests up to 1 MiB and responses up to 32 MiB. Elements hidden with `display: none` are absent from the accessibility tree, so snapshots never list them, even with `includeHidden`.

Console and network tools read bounded per-tab buffers: 1000 entries and 2 MiB for console messages, 2000 records and 8 MiB for network requests. Only output since capture started is kept, plus what the browser replays on enable. Console capture starts when a tab is created or selected, or on the first `console_logs` call if that did not happen. Network capture starts lazily on the first `network_requests` or `network_response_body` call for a tab, so that first call may return nothing and records appear on later calls. A record for a request that began before capture started can have an empty `method` or `url`; method filters never match an empty method. Evicted entries are reported as `droppedCount`. Console messages, network records, mock rules, network emulation and dialogs also cover cross-site iframes: the daemon attaches to each cross-site iframe of a tab, applies the same capture and emulation commands before the iframe starts running, and answers a paused request or a dialog on the iframe that raised it.

Redaction applies to network records. In URLs, the userinfo part of http, https, ws, wss and ftp URLs, the values of query and fragment parameters, and the values of path parameters such as `;jsessionid=...` are replaced by `[redacted]` when the name is sensitive. A name is split into words at non-alphanumeric characters, camelCase boundaries and letter-digit boundaries, and is sensitive when a word is one of `token`, `key`, `secret`, `password`, `passwd`, `pwd`, `pw`, `pass`, `passcode`, `passphrase`, `auth`, `authorization`, `authentication`, `session`, `sid`, `sig`, `signature`, `code`, `otp`, `jwt`, `credential`, `bearer`, `cookie` (or their plurals) or a known compound such as `apikey`, or when a longer word ends in `token`, `secret`, `password`, `passwd`, `sessionid`, `signature` or `apikey`; `api_key`, `apiKey`, `access_token` and `x-auth-token` match while `design`, `monkey` and `keyword` do not. Names are matched after percent decoding. A parameter value that is itself a URL, plain or percent-encoded, is decoded, redacted with the same rules and encoded again. Header values are replaced when the name is `authorization`, `cookie`, `set-cookie`, `proxy-authorization` or `x-api-key`, or is sensitive by the same word rule; the values of `referer`, `location`, `origin` and `content-location` are redacted as URLs. Console text, page content and response bodies are not redacted.

`urlRegex` of `network_requests` and `page_wait` takes a restricted regular expression: up to 200 characters, at most 2 unbounded repeats (`*`, `+`, `{n,}`), no repeated groups that contain repeats or alternation, no backreferences and no lookarounds. A pattern outside this subset is an error. The pattern is tested against the first 2048 characters of the URL, and every match runs in an isolated context with a 50 ms limit. A match that exceeds the limit is stopped and the call fails with an error that asks for a simpler pattern; it is never reported as a non-match.

`timeoutMs` bounds the whole call, including setup. `page_wait` with `loadState: "networkidle"` needs 500 ms of observed quiet; quiet is measured by network capture, so it counts only from when capture started.

Screenshots default to 4 MiB and 4096 pixels per side, raisable to 16 MiB; PDFs default to 8 MiB, raisable to 24 MiB.

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

| Field                     | Flag                          | Env                                       | Values                                                                | Default                                |
| ------------------------- | ----------------------------- | ----------------------------------------- | --------------------------------------------------------------------- | -------------------------------------- |
| `browser`                 | `--browser`                   | `CHROMIUM_DEVTOOLS_MCP_BROWSER`           | `chrome`, more browsers later                                         | `chrome`                               |
| `mode`                    | `--mode`                      | `CHROMIUM_DEVTOOLS_MCP_MODE`              | `attach` (your running browser) or `managed` (own persistent profile) | `attach`                               |
| `headless`                | `--headless`, `--no-headless` | `CHROMIUM_DEVTOOLS_MCP_HEADLESS`          | true or false, managed mode only                                      | false                                  |
| `profileDir`              | `--profile-dir`               | `CHROMIUM_DEVTOOLS_MCP_PROFILE_DIR`       | absolute directory of the managed profile                             | see below                              |
| `debugPort`               | `--debug-port`                | `CHROMIUM_DEVTOOLS_MCP_DEBUG_PORT`        | 0 to 65535                                                            | 0 in managed mode, 9222 in attach mode |
| `allowFocus`              | `--allow-focus`               | `CHROMIUM_DEVTOOLS_MCP_ALLOW_FOCUS`       | allow bringing a window to the front                                  | false                                  |
| `isolated`                | `--isolated`, `--no-isolated` | `CHROMIUM_DEVTOOLS_MCP_ISOLATED`          | open the session in an isolated browser context                       | false                                  |
| `safety.readOnly`         | `--read-only`                 | `CHROMIUM_DEVTOOLS_MCP_READ_ONLY`         | refuse actions that change pages                                      | false                                  |
| `safety.allowedDomains`   | `--allowed-domains`           | `CHROMIUM_DEVTOOLS_MCP_ALLOWED_DOMAINS`   | comma separated list (planned)                                        | empty, no limit                        |
| `safety.confirmDangerous` | `--confirm-dangerous`         | `CHROMIUM_DEVTOOLS_MCP_CONFIRM_DANGEROUS` | ask before dangerous actions (planned)                                | false                                  |

In managed mode the default `debugPort` is 0, so Chrome picks a free port at every launch and the daemon reads the real port back. The port is not predictable, which keeps the unauthenticated debugging endpoint on loopback hard to find for other local processes. A browser left running on the managed profile is found through the profile, not through the port. Set `debugPort` explicitly only when something else needs a fixed port. In attach mode the port is the fallback used to find a browser started with `--remote-debugging-port`, so its default stays 9222.

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
3. Tools: tabs, navigation and inspection, input, observation, emulation, control and storage, network mocking, shadow DOM and iframes (all done).
4. Safety controls (read-only mode works, the rest planned).
5. Client installer.
6. First release.
7. Later: performance traces and Core Web Vitals, Lighthouse, heap snapshots.

Detailed steps are in [docs/PLAN.md](docs/PLAN.md).

## License

MIT
