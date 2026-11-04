# Security policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub private vulnerability reporting for Bramfoxie/chromium-devtools-mcp (the Security tab, then Report a vulnerability). Do not open a public issue for a vulnerability.

Include the version, the platform, the configuration involved and steps to reproduce.

## What the tool exposes

- A local browser debugging endpoint. In attach mode the browser listens on a local port that any local process can reach while debugging is enabled.
- A per-user daemon that serves MCP clients on the same machine. It is protected by a per-user token and accepts local connections only.
- Cookie access and file uploads to web pages. They are guarded by the `safety.readOnly`, `safety.allowedDomains` and `safety.confirmDangerous` options described in [docs/safety.md](docs/safety.md).
