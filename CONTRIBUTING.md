# Contributing

## Setup

Node 24 or newer is required.

```sh
git clone https://github.com/Bramfoxie/chromium-devtools-mcp.git
cd chromium-devtools-mcp
npm install
```

`npm install` enables the repository git hooks. Do not bypass them.

## Scripts

- `npm run lint`: eslint
- `npm run typecheck`: TypeScript without emit
- `npm test`: unit tests and, when a Chrome is found, integration tests in a temporary profile; the test of the built server over stdio runs only when `dist/` exists, so build first
- `npm run build`: compile to `dist/`

## Definition of done

Run `npm run lint && npm run typecheck && npm run build && npm test`. Update the README and docs when behavior changes. Every new behavior has tests in `test/`, and a bug fix starts with a failing test. Unit tests need no browser and no network.

## Code and text

Branch from `develop`. Source, comments, docs and commit messages are English with plain ASCII punctuation. Comments state at most one short contract or constraint. Keep modules small and inject dependencies that touch the OS.

## Commits

One logical change per commit, with its tests and docs. The subject is imperative and up to 72 characters. The body is plain paragraphs that say what the change does and how the behavior differs before and after. Do not wrap lines inside a paragraph. Do not add tool attribution or co-author lines.
