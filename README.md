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
