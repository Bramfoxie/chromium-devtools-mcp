# Installer

Details of the `install` command that writes the server entry into MCP client configs.

```sh
npx chromium-devtools-mcp install --client claude-code
npx chromium-devtools-mcp install --client all --dry-run
npx chromium-devtools-mcp install --client cursor --read-only --allowed-domains example.com
npx chromium-devtools-mcp install --client codex --remove

```

`--client` takes `claude-code`, `cursor`, `codex`, `cherry-studio`, `claude-desktop`, `windsurf`, `gemini-cli`, `vscode`, `vscode-insiders` or `all`, and may be repeated. `all` means the first four; the others are named explicitly so that no folder is created for a program you do not use. Each client is handled on its own: one failure does not stop the others and makes the exit code 1. A usage error exits with 2.

`--scope project` writes the entry into the current directory instead of your user configuration, for the clients that read a project file: Claude Code (`.mcp.json`), Cursor (`.cursor/mcp.json`) and VS Code (`.vscode/mcp.json`). Any other client reports that it has no project scope and the exit code is 1. `--remove` and `--dry-run` work the same way. The file is meant to be committed with the project, so pass server flags only when they are safe for everyone who uses it.

| Client                    | What the installer changes                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code               | `mcpServers` in `~/.claude.json` (user scope), or `$CLAUDE_CONFIG_DIR/.claude.json` when that is set                                                                                                             |
| Cursor                    | `mcpServers` in `~/.cursor/mcp.json` (global)                                                                                                                                                                    |
| Codex                     | table `[mcp_servers.chromium-devtools]` in `~/.codex/config.toml`, or under `$CODEX_HOME` when that is set                                                                                                       |
| Cherry Studio             | nothing: it has no config file to edit, so the installer prints the JSON and the steps for Import from JSON                                                                                                      |
| Claude Desktop            | `mcpServers` in `claude_desktop_config.json` under the Claude folder of the user config directory (`~/Library/Application Support` on macOS, `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` on Linux) |
| Windsurf                  | `mcpServers` in `~/.codeium/windsurf/mcp_config.json`                                                                                                                                                            |
| Gemini CLI                | `mcpServers` in `~/.gemini/settings.json`, other settings are kept                                                                                                                                               |
| VS Code, VS Code Insiders | `servers` in the user `mcp.json` (`Code/User` or `Code - Insiders/User` under the user config directory), with `type` set to `stdio`                                                                             |

The Claude Desktop, Windsurf, Gemini CLI and VS Code entries follow the locations and formats those clients document; they are covered by tests with a fake file system and have not been run inside the clients. The VS Code file may hold comments, which the installer does not parse: such a file is refused and left untouched. Claude Desktop started from the macOS Dock may not find `npx` in its PATH.

Cherry Studio: open Settings, MCP Servers, Add, Import from JSON, paste the printed JSON and save.

The entry is `npx -y chromium-devtools-mcp`, followed by any server flags you pass to the installer (`--mode`, `--headless`, `--read-only`, `--allowed-domains`, `--confirm-dangerous` and the other flags from [configuration.md](configuration.md)). The flags are checked like at server start, so a typo is an error. On Windows the entry runs `cmd /c npx ...`.

Edits are conservative:

- Everything else in the file is kept, including other servers. The Codex file is edited as text, so it stays byte-identical outside the chromium-devtools table. Claude Code and Cursor files are rewritten as JSON with two-space indentation.
- A timestamped copy `<file>.bak-<time>` is made before an existing file is changed, and the new content is written through a temporary file and a rename. If that backup name already exists, a numeric suffix is added without overwriting it.
- A file that is not valid JSON, or a Codex file with a duplicated chromium-devtools table, is refused and left untouched.
- Running the same command again changes nothing and says so. Running it with different flags updates the existing entry in place and keeps extra keys you added to it.
- `--dry-run` prints what would change and the entry, and writes nothing, not even a backup.
- `--remove` deletes only the chromium-devtools entry.

`npx chromium-devtools-mcp install --list` writes nothing and prints, for every client, whether the entry is installed (`installed, up to date`, `installed, differs from the current entry` or `not installed`) and the file it looked at. The comparison is with the entry the installer writes without server options, so an entry made with flags shows as different. It exits with 1 when a file cannot be read.

Run only one installer at a time for a given config file, and close the client before installing if it can write that file. Concurrent changes are not coordinated and may overwrite one another. Restart the client afterwards so it reads the new entry.

## Manual entry

The entry for any other client that accepts a JSON `mcpServers` object:

```json
{
  "mcpServers": {
    "chromium-devtools": { "command": "npx", "args": ["-y", "chromium-devtools-mcp"] }
  }
}
```

Attach mode needs a one-time setup in the browser, described in [daemon.md](daemon.md).
