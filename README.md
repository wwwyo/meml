# meml

Personal memory CLI — agent-callable local memory layer.

個人の input (RSS / GitHub / Slack / local file 等) を local DuckDB に集約し、agent (Claude Code / Cursor / shell) から **raw SQL で直接 query できる** memory layer。

## Status

Pre-alpha — 設計フェーズ。Phase 0 = local markdown ingest（基盤 + md plugin）。
設計の正本は [.agent/prd/local-markdown-ingest/](.agent/prd/local-markdown-ingest/)（`prd.md` / `dd.md`）、アーキテクチャは [AGENTS.md](./AGENTS.md)。

## Getting Started

Prerequisites: [mise](https://mise.jdx.dev/)（tool 管理）、embedding 用に llama.cpp の `llama-server`。

```bash
mise install         # Bun を install
bun install          # 依存解決
llama-server --embeddings -hf <bge-m3 GGUF>:Q8_0 --port 8080  # embedding server を別 shell で常駐
bun run dev -- init
bun run dev -- add ~/notes/foo.md
bun run dev -- sql "SELECT title, sourced_at FROM memory ORDER BY sourced_at DESC LIMIT 5"
```

## CLI

```
meml init [--vault PATH]                       # vault / DB / extension 初期化
meml add <path> [--title TITLE] [--dry-run]    # file ingest (Phase 0 では .md のみ)
meml remove <path>                             # 誤 ingest / orphan の削除
meml sql "<query>" [--json|--csv|--table]      # read-only raw SQL (`-` で stdin)
meml schema [--json]                           # schema export
```

`search` / `recent` / `get` 等の convenience wrapper は持たない（全部 `meml sql` で書く）。

## Design

- **Source-agnostic schema**: source 列で plugin を区別、metadata に固有情報を逃がす
- **Local-first / Unix-native**: local DuckDB、CLI + JSON output、cron で fetch
- **Raw SQL as the only agent interface**: ORM / query builder を入れず、agent は `meml schema` + `meml sql` で直接 SQL を書く
- Built on Bun + DuckDB (`@duckdb/node-api`) + vss extension + llama.cpp (bge-m3)

詳細は [AGENTS.md](./AGENTS.md) と [.agent/prd/](.agent/prd/)。

## License

MIT
