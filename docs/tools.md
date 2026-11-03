# Tools

Every tool with its behavior. Element targeting is in [frames-and-shadow-dom.md](frames-and-shadow-dom.md), limits in [output-limits.md](output-limits.md), safety gating in [safety.md](safety.md).

## Tabs and sessions

- `list_sessions`: list open sessions of the daemon without their tab details. Each session shows the client name the MCP client sent in its initialize request, or `chromium-devtools-mcp` when it sent none.
- `list_tabs`: list the tabs of the session, or with `scope: "available"` the tabs it can claim. Each tab has its id, `url`, `title`, `owned`, `created` and, for owned tabs, `selected`. `limit` defaults to 100 (maximum 500); `total` counts the tabs in the scope and `truncated` tells whether the limit dropped some.
- `select_tab`: select an owned tab, claiming an available one when needed. Never focuses it.
- `new_tab`: open a background tab and select it. With a `url` it waits for the page to commit and load, for at most `timeoutMs` (default 30000), and returns the committed `url` and `title`, `waited` (`load`, `timeout` or `none`), the document `readyState` and the HTTP `status` when observed. A download, an empty 204 response or a network error does not fail the call: the tab stays open, on `about:blank` for a download or a 204 and on the browser error page for a network error, and `navigationError` says why. The tab is never brought to the front.
- `close_tab`: close a tab opened by this session.
- `bring_to_front`: bring a tab and its window to the front and take the keyboard focus. It is the only tool that does, and it works only when `allowFocus` is on (off by default); otherwise it refuses and says so. It acts on the given tab or the selected one, does not change the selection, and in read-only mode or on a tab outside `safety.allowedDomains` it is refused like other state changing tools. Use it only when the user asked to see the tab.
- `page_info`: read the URL, title, viewport, scroll position and emulation state of a tab.
- `page_navigate`: open a URL, go back or forward, or reload, waiting for the page to load. Back and forward refuse a history entry that is not an http, https or about:blank page.

## Inspection and navigation

- `js_evaluate`: run JavaScript in a tab. Page exceptions come back as data, not as tool errors. The exception text and the value are cut at `maxResultChars` with a marker; a value that cannot be serialized within the 32 MiB protocol limit is reported as its description with `truncated: true`.
- `dom_query`: find elements by a CSS selector and read their text, attributes and boxes.
- `dom_snapshot`: read a compact text snapshot of the page with element ids.
- `css_inspect`: read the computed style, matched CSS rules and box of an element. The result carries `totalRules`, `truncated` and `droppedWinners`, the properties whose winning declaration is in a rule that `maxRules` dropped.
- `click`: click an element at the DOM level with `element.click()` semantics. Works on covered elements and background tabs; the event is not trusted.

## Input

- `input_click`: click with trusted CDP mouse events, like a real user. Pass either a `target` element or a `point`, never both. With a `target` it refuses a covered element unless `force` is passed. A `point` is `{ x, y }` in CSS pixels from the top left corner of the viewport, which are the pixel coordinates of a viewport `screenshot` at scale 1, so a vision based agent can click what it sees. The events go to the tab at those coordinates, also over a cross-site frame, and no hit test is made: the result names the element under the point (an `iframe` for a frame) and omits `target` when nothing is there. A point outside the viewport is refused. `button`, `clickCount` and `modifiers` work for both; `position` and `force` are for a `target` only. With `safety.allowedDomains` a point inside a frame from another origin is refused, and so is a point whose frame cannot be identified.
- `input_hover`: hover an element with trusted CDP mouse events, so hover styles and menus react.
- `input_type`: type text into a field, with `clear` and `submit` options. Passwords are typed but never echoed back.
- `input_key`: press a key or chord like `Enter` or `ControlOrMeta+C`. `ControlOrMeta` resolves from the browser platform. On macOS, Control combined with a letter does not trigger editing commands such as select all; use `Meta+A` or `ControlOrMeta+A` there.
- `input_scroll`: scroll by wheel deltas, to the top or bottom, or an element into view. Reports honestly when the wheel left the window position unchanged.
- `input_select`: choose options of a `select` by value, label or index.
- `input_upload`: attach local files to a file input. This is the most sensitive tool: it sends local files to a web page. Paths are validated on the server machine (absolute, existing regular readable files under 100 MiB, at most 20), symlinks are followed, and results carry file names and sizes only, never contents.

## Observation, control and storage

- `network_requests`: read HTTP requests of a tab with URL, method, resource type, status and failure filters.
- `network_response_body`: read the response body of a request from `network_requests`. Binary bodies need `asBase64`; without it the result has `needsBase64: true` and no body. `maxChars` defaults to 50000 and allows up to 500000; a base64 body is cut at a multiple of 4 characters and always keeps at least 4. Bodies over the 32 MiB transport limit are refused. Redirect responses have no body.
- `network_mock`: mock responses or fail requests by Fetch wildcard pattern (`*`, `?` and the `\` escape), with delay and a use count. First match in insertion order wins.
- `console_logs`: read console messages, uncaught exceptions and browser messages of a tab, with level and text filters, paging and clear.
- `page_dialogs`: see and resolve JavaScript dialogs, or set an automatic accept or dismiss policy for later ones.
- `page_wait`: wait for a selector, text, URL, load state or expression. A timeout returns `met: false`, not an error.
- `storage_read`: read local storage, session storage or cookies of the page origin. Values of all kinds are hidden by default: the result lists keys (or cookie names) with the value size and `includeValues: false`. Pass `includeValues: true` to read values.
- `storage_write`: write local storage, session storage or cookies of the page origin. Cookie domains must match the page host. `clear` needs `confirm: true`.
- `page_pdf`: print a tab to PDF with orientation, paper, margins and page ranges. Needs a headless managed browser when the headed browser refuses to print. The PDF defaults to 8 MiB and `maxBytes` raises that to 24 MiB; a larger PDF is refused with a hint to use `pageRanges`.
- `page_metrics`: read performance counters, layout metrics and navigation timing of a tab.
- `screenshot`: capture a tab as an image. Defaults to jpeg quality 80; supports viewport, full page, element and clip shots.
- `list_devices`: list the built in devices for `emulate_device`, with an optional name or kind filter.

## Emulation

- `emulate_device`: emulate a device size, pixel ratio, mobile viewport, touch and user agent. The Chrome version in the user agent of a desktop or Android device follows the connected browser. Client hints metadata is not emulated.
- `emulate_media`: emulate a media type and media features such as color scheme and reduced motion. Only the given fields change, and reset: true cannot be combined with other fields.
- `emulate_network`: emulate network conditions with a preset (offline, slow-3g, fast-3g, 4g, wifi, none), custom latency and throughput (a throughput of 0 is rejected, use -1 to remove the limit), or blocked URL patterns. The none preset also clears blocked URLs, and reset: true cannot be combined with other fields. Shares `Network.enable` with the capture tools and never disables capture.
- `emulate_locale`: emulate locale, timezone and Accept-Language. Takes effect on the next page load: `navigator.language` changes after navigation, and number and date formatting follow the locale. Geolocation is not emulated: it needs the Browser domain, which is not reachable through a tab.

## Behavior notes

Each emulation tool returns the full emulation state of the tab, plus what the page reports (viewport, media queries, language) when the page answers. `reset: true` removes only the overrides of that tool. Overrides live in the tab session and are gone when the tab closes or the session resets. Device emulation reports the inner size the page sees: without a viewport meta tag a mobile page keeps its default 980 CSS pixel layout width.

Input tools never bring the browser window to the front. The page believes it is focused through CDP focus emulation, enabled once per tab, so mouse and keyboard events behave like a real user while your windows stay put.

Dialog capture starts when a tab is created or selected: while a dialog is open, tools that run page scripts fail fast and name `page_dialogs` instead of timing out. The dialog policy auto-resolves later dialogs including `beforeunload` and is cleared on reset. A dialog that was already open before the tab was first created or selected cannot be observed, so `page_dialogs` cannot see or resolve it: the browser does not answer Page.enable while it is open, so the first call fails after 3 seconds with a message to resolve the dialog in the browser.

Storage tools only touch the page origin. Cookie reads never leave the page URL: no `urls` parameter is sent and `Network.getAllCookies` is never used. Cookie writes always carry the page URL, and the domain must equal the page host or be its parent domain. Values are never logged; values of local storage, session storage and cookies are only returned with `includeValues: true`.

Mock rules live per tab in the MCP process: at most 100 rules, bodies up to 10 MiB each and 64 MiB in total, delays up to 30 seconds. Requests that match no rule continue untouched. Rules survive navigation and are removed on tab close, session reset and `clear`. A `times` limit expires the rule after that many applications that were answered with the mock; a request that failed or was released unmocked does not use up the limit, and an exhausted rule is removed once its last held request is done. A request delayed by `delayMs` stays held until the delay ends. `remove` releases the requests held by the removed rule so they continue to the network unmocked, and leaves requests held by other rules alone; when the removed rule was the last one, interception is disabled. `clear` and any other disabling of interception release held requests the same way, unmocked.
