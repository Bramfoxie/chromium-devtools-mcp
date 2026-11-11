# Troubleshooting

Common problems and what to do about them. Start with these three commands, they change nothing:

```sh
npx chromium-devtools-mcp doctor
npx chromium-devtools-mcp daemon status
npx chromium-devtools-mcp daemon logs
```

Add to `doctor` the same flags as in your client entry, so it checks the same settings. Details of each command are in [daemon.md](daemon.md).

## The browser is not found in attach mode

- Chrome has to allow remote debugging: open `chrome://inspect/#remote-debugging`, turn it on for this browser instance and click Allow when Chrome asks. Until then the daemon prints the setup steps and keeps checking.
- Starting Chrome with `--remote-debugging-port` works only together with `--user-data-dir` pointing to another directory, because Chrome 136 and newer ignore the flag on the default profile.
- On macOS the message may say that Chrome's `DevToolsActivePort` file cannot be read. That is the operating system refusing the app that starts the server (the MCP client), not a sign that debugging is off. Turn on Full Disk Access for that app in System Settings, Privacy & Security, then restart it. As an alternative, run `npx chromium-devtools-mcp daemon` once in a terminal that has access.
- With `wsEndpoint` set the daemon connects to that address and never prints the setup steps. A browser that asks for approval of that connection can still be answered within 120 seconds.
- Connection errors and daemon settings do not include the browser WebSocket address. Check the configured `wsEndpoint` locally when diagnosing a failed connection.

## A client gets an error about differing settings

All clients of one daemon must agree on `browser`, `mode`, `debugPort` and `allowFocus` (and on a few more in each mode). The error names the differing fields. Align the settings, or run `chromium-devtools-mcp daemon stop` and start the clients again. After updating the package, stop a daemon of an older version in the same way, because it rejects settings that are new.

An older daemon can also reject a new session setting as an unknown field. Stop that daemon and retry with the updated package. Stopping the shared daemon disconnects its clients.

## The managed browser does not start

- The browser must be installed; `doctor` checks that and that the profile directory can be written.
- One profile directory belongs to one browser instance. If another Chrome already uses the `profileDir`, give this server another directory.
- A managed browser left running can be reused only when its private profile identity record is available. If it is missing, including after an upgrade from a version without identity records, close that browser before starting the daemon again. A fixed debug port or a copied `DevToolsActivePort` file does not identify its profile.
- The daemon log shows why a start failed: `daemon logs`.

## A page is refused because it is local

By default navigation to `localhost`, private network addresses and names such as `*.local` is refused. Set `safety.allowPrivateNetworks` to `true`, or list the host in `safety.allowedDomains`. See [safety.md](safety.md).

## A tool is refused by a safety option

The message names the option. `safety.readOnly` refuses every tool that changes a page, `safety.allowedDomains` and `safety.deniedDomains` refuse tabs, frames and targets outside the rules, and `safety.confirmDangerous` needs a client that supports confirmation questions: a client without them gets an error that tells you to turn the option off. See [safety.md](safety.md).

## A click or scroll does not reach a frame from another site

Cross-site frames run in their own process, and a tab in the background may not deliver trusted wheel events or clicks to them reliably. The tools report when delivery cannot be confirmed and do not hide it. Bringing the tab to the front with `bring_to_front` (needs `allowFocus`) can help; use it only when you want the window to be shown. See [frames-and-shadow-dom.md](frames-and-shadow-dom.md).

## The installer

- Claude Code may rewrite `~/.claude.json` while it runs and drop the new entry, so install while it is closed.
- Claude Desktop started from the macOS Dock may not find `npx` in its PATH.
- A VS Code `mcp.json` with comments is refused and left unchanged; remove the comments or add the entry by hand.
- Restart the client after the installer changed its file. See [install.md](install.md).

## Windows

- If `npx` fails with a command not recognized error and its npm cache path contains `&`, use an npm cache directory with no `&` in its absolute path. In PowerShell, set `$env:npm_config_cache` to a writable directory owned by your user before starting `npx` or the client that launches it. npm creates command wrappers in its cache, and the Windows wrapper can misinterpret `&` in that path. For an already installed package, running its `dist/cli.js` with Node directly also avoids the wrapper.
- Deleting `daemon.token` while a daemon runs makes the next client start a second daemon, because the pipe name derives from the token. Run `daemon stop` first.
- A managed browser is a child of the daemon and closes when the daemon exits.
