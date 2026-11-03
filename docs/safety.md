# Safety

Read-only mode, the domain allowlist and the confirmation of dangerous actions: behavior and limits.

`safety.allowedDomains` is a list of host rules. Accepted forms: a host (`example.com`, matches only that host), a wildcard (`*.example.com`, matches subdomains but not the bare domain), an optional port (`localhost:3000`) and a bracketed IPv6 address (`[::1]:3000`). Without a port a rule matches any port. Any other entry, such as `https://example.com`, `example.com/path`, `*`, an empty string or a host with spaces, is rejected at startup with a configuration error of the form `invalid configuration: safety.allowedDomains.0: invalid entry "https://example.com", accepted forms: ...`. An empty list means no limit.

With a list set:

- `new_tab` and `page_navigate` refuse a URL outside the list, and `page_navigate` with `back` or `forward` refuses a history entry outside it.
- After a navigation, the tab URL that the page ended on after redirects is checked too. When it is outside the list, the tab is moved to `about:blank` and the tool reports the host and what to do (`page_navigate` fails with an error, `new_tab` returns it as `navigationError` and keeps the tab open). If the tab cannot be moved, the message says it still shows that page.
- A mutating tool refuses a tab whose current URL is outside the list, and refuses an element, or an `input_click` point, inside a frame whose origin is outside the list. Read tools keep working on such tabs. `page_navigate` to an allowed URL, `new_tab`, `select_tab` and `close_tab` stay available so a tab can be moved away or closed.
- An element target with `pierce: true` is checked at execution time: the URL of the document that holds the matched element must be inside the list, otherwise the tool refuses. A `>>>` chain only crosses shadow roots and stays in the frame it starts in.
- When the frame of the target cannot be looked up, the call is refused with a message to call the tool again.
- The URL is read when the tool starts, so a page that navigates itself later is caught at the next mutating call.
- `storage_write` reads the page URL again right before it writes and refuses when it is outside the list.

`safety.confirmDangerous` asks the user before a dangerous call. Dangerous tools are `js_evaluate`, `page_wait` with an `expression`, `storage_write`, `storage_read` with `kind: "cookies"` and `input_upload`; they carry `destructiveHint: true`. With the option on, the server asks through MCP elicitation and runs the tool only when the user accepts. The question names the tool and a short summary (the script, the storage kind and action, or the file paths) and never contains cookie values or file contents. `storage_read` hides values of every kind unless `includeValues: true` is passed, and the question says when values are requested. A client without elicitation support gets an error that tells the owner to set `safety.confirmDangerous` to false, and a declined or failed question also runs nothing. `close_tab`, `network_mock` and the `input_*` tools other than `input_upload` are not dangerous. `close_tab` only closes tabs opened by the session; a tab it merely claimed is refused.

`safety.readOnly` refuses every tool that changes page or browser state: `new_tab`, `select_tab`, `close_tab`, `bring_to_front`, `page_navigate`, `js_evaluate`, `click`, `input_*`, `emulate_*`, `storage_write`, `page_wait` with an `expression`, `network_mock` actions other than `list`, `page_dialogs` actions other than `status` or with a policy, and `screenshot` with a `target`. Reading tools, including cookie reads, keep working. A tool whose annotation depends on its arguments reports `readOnlyHint: false`, and only the calls that change state are refused.

The daemon enforces the safety options of each session itself, so a client cannot widen them by talking to the daemon directly. For a session it refuses `tab.create` and `Page.navigate` outside the allowlist or in read-only mode, and it applies the options to the CDP methods that reach beyond the page: `Network.getCookies` and `Storage.getCookies` (reads), `Network.setCookie`, `Network.setCookies`, `Network.deleteCookies`, `Storage.setCookies`, `Storage.clearCookies` and `DOM.setFileInputFiles` (changes). Changes are refused in read-only mode; changes are refused when the tab (or the frame given) is outside the allowlist or when a cookie is written for a `url` or `domain` outside it. Methods of the `Storage` domain and `Network.setCookies` are also blocked by the general method policy.

### Limits of the allowlist

- Only top-level URLs and the frame a tool acts in are checked. Subresource and iframe loads from other hosts are not blocked.
- `network_mock` patterns are not matched against the list; only the URL of the tab is checked.
- Cookie reads are gated by `safety.confirmDangerous` only, not by `safety.allowedDomains`.
