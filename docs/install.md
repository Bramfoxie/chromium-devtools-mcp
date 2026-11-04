# Installer

Details of the `install` command that writes the server entry into MCP client configs.

```sh
npx chromium-devtools-mcp install --client claude-code
npx chromium-devtools-mcp install --client all --dry-run
npx chromium-devtools-mcp install --client cursor --read-only --allowed-domains example.com
npx chromium-devtools-mcp install --client codex --remove

```

`--client` takes `claude-code`, `cursor`, `codex`, `cherry-studio` or `all`, and may be repeated. Each client is handled on its own: one failure does not stop the others and makes the exit code 1. A usage error exits with 2.

| Client        | What the installer changes                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| Claude Code   | `mcpServers` in `~/.claude.json` (user scope), or `$CLAUDE_CONFIG_DIR/.claude.json` when that is set        |
| Cursor        | `mcpServers` in `~/.cursor/mcp.json` (global)                                                               |
| Codex         | table `[mcp_servers.chromium-devtools]` in `~/.codex/config.toml`, or under `$CODEX_HOME` when that is set  |
| Cherry Studio | nothing: it has no config file to edit, so the installer prints the JSON and the steps for Import from JSON |

Cherry Studio: open Settings, MCP Servers, Add, Import from JSON, paste the printed JSON and save.

The entry is `npx -y chromium-devtools-mcp`, followed by any server flags you pass to the installer (`--mode`, `--headless`, `--read-only`, `--allowed-domains`, `--confirm-dangerous` and the other flags from [configuration.md](configuration.md)). The flags are checked like at server start, so a typo is an error. On Windows the entry runs `cmd /c npx ...`.

Edits are conservative:

- Everything else in the file is kept, including other servers. The Codex file is edited as text, so it stays byte-identical outside the chromium-devtools table. Claude Code and Cursor files are rewritten as JSON with two-space indentation.
- A timestamped copy `<file>.bak-<time>` is made before an existing file is changed, and the new content is written through a temporary file and a rename.
- A file that is not valid JSON, or a Codex file with a duplicated chromium-devtools table, is refused and left untouched.
- Running the same command again changes nothing and says so. Running it with different flags updates the existing entry in place and keeps extra keys you added to it.
- `--dry-run` prints what would change and the entry, and writes nothing, not even a backup.
- `--remove` deletes only the chromium-devtools entry.

Restart the client afterwards so it reads the new entry. If Claude Code is running while the installer edits `~/.claude.json`, it may rewrite the file and drop the entry, so install while it is closed.

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
