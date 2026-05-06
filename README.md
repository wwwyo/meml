# meml

Personal memory CLI — agent-callable local memory layer.

Aggregate personal input (RSS / GitHub / Slack / ...) into a local SQLite vault, query it from any agent (Claude Code / Cursor / shell) via CLI + JSON output.

## Status

Phase 0 (RSS plugin only). Pre-alpha — under active dogfooding.

## Getting Started

Prerequisites: [mise](https://mise.jdx.dev/) for tool management.

```bash
mise install         # installs Bun
bun install          # resolve dependencies
bun run dev -- init --vault ~/Documents/Memory-Vault
bun run dev -- rss add https://example.com/feed.xml
bun run dev -- fetch
bun run dev -- recent --json
```

## CLI

```
meml init [--vault PATH]

# RSS plugin (Phase 0)
meml rss add <url>
meml rss list
meml rss remove <id>
meml rss fetch [--feed ID]

# Cross-source query
meml search <query> [--source S] [--since 7d] [--json]
meml recent [--days N] [--unread] [--json]
meml get <id> [--json]
meml mark-read <id>

# Periodic fetch (cron)
meml fetch [--source S]
```

## Design

See [AGENTS.md](./AGENTS.md) for architecture. Source-agnostic schema; plugins per source. Built on Bun + `bun:sqlite` + sqlite-vec + fastembed-node.

## License

MIT
