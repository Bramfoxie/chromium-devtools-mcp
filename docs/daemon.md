# Daemon and sessions

How the per-user daemon, sessions, browser modes and attach setup work.

## Daemon

- It exits 30 seconds after its last client disconnects, also while it is still waiting for the browser.
- When it exits on idle, a managed browser with a window stays open and the next daemon reuses it. A headless managed browser is closed on idle, and any managed browser is closed when the daemon is stopped on request. Both apply only to a browser this daemon launched: a browser the daemon reused from an earlier run is only disconnected and keeps running.
- On Windows a managed browser is a child of the daemon and closes when the daemon exits, so it is not kept open on idle and is not reused after a daemon crash.
- Starting a managed browser with a window can briefly take the keyboard focus, because the operating system activates a new window. Everything the daemon does afterwards, such as opening, navigating and closing tabs, leaves the focus alone.
- Clients must agree on `browser`, `mode`, `debugPort` and `allowFocus`, and in managed mode also on `headless` and `profileDir`. A client with different settings gets an error that names the differing fields; stop the daemon or align the settings. `isolated` and the `safety` options are per session and may differ between clients.
- On Windows the name of the daemon pipe derives from the token, so deleting `daemon.token` while a daemon runs makes the next client start a second daemon. Stop the daemon before removing the token.
- Its log is `daemon.log` in the data directory of the package: `~/Library/Application Support/chromium-devtools-mcp/daemon.log` on macOS, `~/.local/share/chromium-devtools-mcp/daemon.log` on Linux and `%LOCALAPPDATA%\chromium-devtools-mcp\daemon.log` on Windows. The access token `daemon.token` lives in the same directory and is readable only by you.
- Tabs can open only `http`, `https` and `about:blank` URLs.

## Attach mode setup

- A recent Chrome: open `chrome://inspect/#remote-debugging` and turn on remote debugging for this browser instance. Chrome may ask you to allow a connection; click Allow.
- Start Chrome with `--remote-debugging-port=<debugPort>`. Chrome 136 and newer ignore this flag on the default profile, so it also needs `--user-data-dir` pointing to another directory.

Until the browser allows it, the daemon prints these instructions, returns them to the client and keeps checking.

Once the browser allows it, the status message changes to a request to click Allow in Chrome and the daemon logs `Connecting to Chrome on port <port>.`. A connection attempt that Chrome does not complete within 120 seconds is closed and logged as `could not connect to the browser yet, retrying`; the daemon then resolves the endpoint again and retries on a new connection. The log line `Connected to Chrome on port <port>.` marks the end of the wait.
