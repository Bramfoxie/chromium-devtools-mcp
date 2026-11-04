# Configuration

All settings, their flags and environment variables, defaults, precedence and the config file location.

The file is `~/.config/chromium-devtools-mcp/config.json` on macOS and Linux and `%APPDATA%\chromium-devtools-mcp\config.json` on Windows. Set `CHROMIUM_DEVTOOLS_MCP_CONFIG` to use another path. A missing file at the overridden path is an error, so a typo never silently drops your settings.

| Field                     | Flag                          | Env                                       | Values                                                                | Default                                |
| ------------------------- | ----------------------------- | ----------------------------------------- | --------------------------------------------------------------------- | -------------------------------------- |
| `browser`                 | `--browser`                   | `CHROMIUM_DEVTOOLS_MCP_BROWSER`           | `chrome`, more browsers later                                         | `chrome`                               |
| `mode`                    | `--mode`                      | `CHROMIUM_DEVTOOLS_MCP_MODE`              | `attach` (your running browser) or `managed` (own persistent profile) | `attach`                               |
| `headless`                | `--headless`, `--no-headless` | `CHROMIUM_DEVTOOLS_MCP_HEADLESS`          | true or false, managed mode only                                      | false                                  |
| `profileDir`              | `--profile-dir`               | `CHROMIUM_DEVTOOLS_MCP_PROFILE_DIR`       | absolute directory of the managed profile                             | see below                              |
| `debugPort`               | `--debug-port`                | `CHROMIUM_DEVTOOLS_MCP_DEBUG_PORT`        | 0 to 65535                                                            | 0 in managed mode, 9222 in attach mode |
| `wsEndpoint`              | `--ws-endpoint`               | `CHROMIUM_DEVTOOLS_MCP_WS_ENDPOINT`       | `ws://127.0.0.1:<port>/devtools/browser/<id>`, attach mode only       | unset, the browser is found by itself  |
| `allowFocus`              | `--allow-focus`               | `CHROMIUM_DEVTOOLS_MCP_ALLOW_FOCUS`       | allow the `bring_to_front` tool                                       | false                                  |
| `isolated`                | `--isolated`, `--no-isolated` | `CHROMIUM_DEVTOOLS_MCP_ISOLATED`          | open the session in an isolated browser context                       | false                                  |
| `safety.readOnly`         | `--read-only`                 | `CHROMIUM_DEVTOOLS_MCP_READ_ONLY`         | refuse actions that change pages                                      | false                                  |
| `safety.allowedDomains`   | `--allowed-domains`           | `CHROMIUM_DEVTOOLS_MCP_ALLOWED_DOMAINS`   | comma separated list of host rules, see [safety.md](safety.md)        | empty, no limit                        |
| `safety.confirmDangerous` | `--confirm-dangerous`         | `CHROMIUM_DEVTOOLS_MCP_CONFIRM_DANGEROUS` | ask before dangerous actions, see [safety.md](safety.md)              | false                                  |

In managed mode the default `debugPort` is 0, so Chrome picks a free port at every launch and the daemon reads the real port back. The port is not predictable, which keeps the unauthenticated debugging endpoint on loopback hard to find for other local processes. A browser left running on the managed profile is found through the profile, not through the port. Set `debugPort` explicitly only when something else needs a fixed port. In attach mode the port is the fallback used to find a browser started with `--remote-debugging-port`, so its default stays 9222.

`wsEndpoint` names the exact browser to attach to, for a browser started elsewhere (another tool, a container with a published port, a script). The daemon then skips the search for a browser and connects to that address. The host must be `127.0.0.1`, `localhost` or `[::1]`, the port must be explicit and the path must start with `/devtools/browser/`; anything else is a configuration error from every source. It is an error in managed mode. The id in the address changes every time the browser starts, so after a browser restart the old address no longer works: the daemon keeps retrying, tells the client that the endpoint is unreachable and logs `could not connect to the browser yet, retrying`.

The default `profileDir` is `~/Library/Application Support/chromium-devtools-mcp/profile` on macOS, `~/.local/share/chromium-devtools-mcp/profile` on Linux and `%LOCALAPPDATA%\chromium-devtools-mcp\profile` on Windows.

`safety.allowedDomains` entries are host rules: `example.com`, `*.example.com`, `localhost:3000` or `[::1]:3000`. An entry that is not one of these forms (a URL such as `https://example.com`, a path, a bare `*`, an empty string or a host with spaces) is a configuration error from every source, the config file, the environment variable and the flag, and the installer reports it with exit code 2.

Boolean env values accept `true`, `1`, `false`, `0`, case-insensitively, with surrounding whitespace ignored. An empty or whitespace-only env value counts as unset. Every boolean flag also accepts a `--no-` form, for example `--no-read-only`.

On macOS and Linux `XDG_CONFIG_HOME` overrides the directory of the config file. On Linux `XDG_DATA_HOME` overrides the directory of the managed profile; on macOS the profile always lives under `~/Library/Application Support`. On Windows `APPDATA` and `LOCALAPPDATA` play the same roles. Empty or relative values of these variables are ignored.

An unknown flag, a missing value or a stray argument is an error, so a typo never silently changes the behavior.

## Client agreement

Several MCP clients share one daemon, so some settings must match between them. See [daemon.md](daemon.md).
