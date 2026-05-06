# meml

Personal memory CLI — RSS / GitHub / Slack 等のソースから個人の input を local SQLite に集約し、CLI として agent (Claude / Cursor / shell skill) から呼び出せる memory layer。

## ディレクトリ構造

```
meml/
├── src/
│   ├── index.ts        エントリポイント (CLI parser)
│   ├── commands/       subcommand 実装
│   ├── plugins/        source plugin (rss, ...)
│   ├── storage/        SQLite + sqlite-vec
│   └── embedding/      embedding engine
├── package.json
├── tsconfig.json
├── .mise.toml
└── README.md
```

## セットアップ

```bash
mise install         # Bun を install
bun install          # 依存解決
bun run dev          # 開発実行
bun test             # テスト
bun run lint         # oxlint
bun run format       # oxfmt
```

## 技術スタック

- **Runtime**: Bun (built-in TS / sqlite / test)
- **Lang**: TypeScript
- **DB**: `bun:sqlite` + sqlite-vec extension
- **Embedding**: fastembed-node (default) / OpenAI API (opt-in)
- **CLI parser**: commander (or Bun built-in)
- **RSS**: rss-parser
- **Lint**: oxlint
- **Format**: oxfmt
- **Test**: `bun:test`

## 設計思想

- **Source-agnostic schema**: source 列で plugin を区別、metadata に固有情報を逃がす
- **Local-first**: vault folder は user-owned 実ファイル
- **Unix-native**: CLI + JSON output、cron で fetch、shell skill / Bash tool から叩ける
- **Build wide as tool, productize narrow**: 個人 dogfood で広く、製品化は narrow に絞る

## CLI 設計

namespace パターン (`gh repo` / `gh pr` 流儀):

```
meml init [--vault PATH]

# Source-specific (Phase 0 = rss のみ)
meml rss add <url>
meml rss list [--json]
meml rss remove <id>
meml rss fetch [--feed ID]

# Cross-source query (source-agnostic)
meml search <query> [--source S] [--since 7d] [--limit N] [--json]
meml recent [--days N] [--unread] [--source S] [--json]
meml get <id> [--json]
meml mark-read <id>
meml mark-summarized <ids...>

# 全 source 一括 fetch (cron 用)
meml fetch [--source S]
```

## データモデル

```sql
CREATE TABLE memory (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,           -- "rss" | "github" | ...
  url           TEXT,
  title         TEXT,
  content       TEXT,
  metadata      TEXT,                    -- JSON: source 固有情報
  created_at    TIMESTAMP NOT NULL,
  read_at       TIMESTAMP,
  summarized_at TIMESTAMP,
  UNIQUE(source, url)
);

CREATE TABLE memory_chunks (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL REFERENCES memory(id),
  chunk_index INTEGER NOT NULL,
  content     TEXT NOT NULL,
  embedding   BLOB
);
```

## Phase plan

- **Phase 0**: RSS plugin のみ (今週末)
- **Phase 1**: GitHub plugin (PR / issue / commit)
- **Phase 2**: Slack plugin (DM / mention / post)
- **Phase 3**: Calendar / Notes plugin (URL なき source、`source_id` 列追加検討)

## 関連ドキュメント

設計議論の経緯: [wwwyo/me — ideas/meml.md](https://github.com/wwwyo/me/blob/main/ideas/meml.md)

## コミュニケーション方針

- 忖度しない。問題点やリスクがあれば率直に指摘する
- コメントは「なぜ」を説明する場合にのみ書く
