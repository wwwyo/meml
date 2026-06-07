# meml

Personal memory CLI — RSS / GitHub / Slack / local file 等のソースから個人の input を local DuckDB に集約し、agent (Claude / Cursor / shell skill) から **raw SQL で直接 query できる** memory layer。

## ディレクトリ構造

```
meml/
├── src/
│   ├── index.ts        エントリポイント (CLI parser)
│   ├── commands/       subcommand 実装
│   ├── plugins/        source plugin (md, rss, ...)
│   ├── storage/        DuckDB + vss、schema migration (migrations/*.sql)
│   └── embedding/      embedding engine
├── .agent/prd/         feature ごとの PRD
├── package.json
├── tsconfig.json
├── .mise.toml
└── README.md
```

## セットアップ

```bash
mise install         # Bun を install
bun install          # 依存解決
llama-server --embeddings -hf <bge-m3 GGUF>:Q8_0 --port 8080  # embedding server を別 shell で常駐
bun run dev          # 開発実行
bun test             # テスト
bun run lint         # oxlint
bun run format       # oxfmt
```

## 技術スタック

- **Runtime**: Bun (built-in TS / test)
- **Lang**: TypeScript
- **DB**: DuckDB + vss extension (`@duckdb/node-api`)
- **Embedding**: llama.cpp (llama-server) + bge-m3 (default, 1024 dim / 多言語)。engine は `src/embedding` で interface 化し差し替え可能 (Ollama / OpenAI 等)
- **CLI parser**: commander (or Bun built-in)
- **RSS**: rss-parser
- **Lint**: oxlint
- **Format**: oxfmt
- **Test**: `bun:test`

## 設計思想

- **Source-agnostic schema**: source 列で plugin を区別、metadata に固有情報を逃がす
- **Local-first**: vault folder は user-owned 実ファイル、meml は file 本体を所有しない
- **Unix-native**: CLI + JSON output、cron で fetch、shell skill / Bash tool から叩ける
- **Raw SQL as the only agent interface**: ORM / query builder を入れない。agent は `meml schema` + `meml sql` で直接 SQL を書く。convenience wrapper (`search` / `recent` / `get`) は持たない
- **Build wide as tool, productize narrow**: 個人 dogfood で広く、製品化は narrow に絞る

## CLI

```
meml init [--vault PATH]                       # vault / DB / extension 初期化 (embedding server 接続も check)
meml add <path> [--title TITLE] [--dry-run]    # file ingest (Phase 0 では .md のみ)
meml remove <path>                             # 誤 ingest / orphan の削除

meml sql "<query>" [--json|--csv|--table]      # read-only raw SQL (- で stdin)
meml schema [--json]                           # schema export

# Plugin (Phase 3+)
meml rss add/list/remove/fetch <url>
meml fetch [--source S]                        # 全 source 一括 fetch (cron 用)
```

- `meml sql` は **read-only**（単一 statement + SELECT/WITH allowlist、COPY/ATTACH/INSTALL/LOAD 等も拒否）。`-` で stdin から SQL 可
- 出力 default は stdout の TTY 判定: 非 TTY (pipe / agent) なら JSON、TTY なら table（`--json`/`--csv`/`--table` or `MEML_OUTPUT=json` で固定）。失敗時は stderr に固定 shape の構造化エラー `{"error":{"code","message","hint"}}`
- semantic search は SQL 内の `meml_embed('text')` で表現（CLI 側 preprocessor が literal を embed して bind 置換）
- Default vault: `~/.meml/`、DB file: `<vault>/meml.duckdb`
- データモデル (schema) / データ取り込み方針は feature ごとの PRD / DD を正本とする。schema は `meml schema` で動的に引ける

## DB Migration

- schema 変更は `src/storage/migrations/<NNNN>_<name>.sql`（4桁ゼロ詰め + 小文字、例 `0002_add_tags.sql`）。`migrations/index.ts` がディレクトリを **自動収集**（ファイル名順 = 適用順）するので、**追加は file を置くだけ**で登録不要。命名規約外・番号重複は読み込み時にエラーで落ちる
- **migration は immutable**: 一度 commit した `.sql` は編集・並べ替え禁止。schema 変更は必ず新しい番号の file を足す（中身を書き換えても version 一致で再適用されず黙って drift する）。`FLOAT[1024]` 等の config 由来値も migration 内では literal で焼く
- baseline `0001_init.sql` のみ `IF NOT EXISTS`（既存 DB への導入を非破壊に）。以降は素の DDL を1回だけ適用
- 適用状態は repo の file ではなく **vault DB 内の `schema_migrations` テーブル**で管理。`meml init` が未適用のみを各 transaction で冪等適用する
- 仕組みの判断・不採用案 (Drizzle 等) は本 feature の decision.log (`.agent/prd/local-markdown-ingest/`) を正本とする

## 関連ドキュメント

- 設計議論の経緯: [wwwyo/me — wiki/syntheses/data-platform-architecture.md](https://github.com/wwwyo/me/blob/main/wiki/syntheses/data-platform-architecture.md)
- 設計議論の memo: [wwwyo/me — ideas/meml.md](https://github.com/wwwyo/me/blob/main/ideas/meml.md)
