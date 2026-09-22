# local-markdown-ingest

## Introduction / Overview

ローカルの markdown ファイル（手書きメモ等）を `meml add <path>` で取り込み、agent から `meml sql` 経由で引けるようにする feature。

meml の **基盤実装（DuckDB / embedding pipeline / CLI 骨格）** をこの PRD のスコープに含める。md ingest は最初に動かす plugin であり、基盤と同時に作る。RSS plugin 等の pull 系 source は後続 PRD で扱う。

長期 vision として、現在 `wwwyo/me` リポジトリで管理している daily memo / wiki / todo を meml に migration する流れの起点。

## Goals

- meml の基盤（DuckDB schema / migration / embedding pipeline / CLI 骨格）を確立する
- 手書き md memo を memory stack に取り込み、`meml sql`（raw SQL）で構造化 + semantic の両方の query で引けるようにする
- agent が直接 SQL を書ける CLI surface を提供する（embedding は SQL 内の `meml_embed('text')` として組み込む）
- 後続 PRD（RSS / PDF / 画像 / wwwyo/me migration）が乗る foundation を作る

## Non-Goals

- RSS / GitHub / Slack 等の pull 系 plugin（後続 PRD）
- PDF / 画像 ingest（後続 phase）
- frontmatter / inline hashtag のパース（md 特別扱いの原則を破らない）
- LLM による title / signals 抽出（title は arg + filename fallback）
- watched folder / 自動取り込み / file 更新監視（手動 only）
- 書き込み系 SQL の許可（`meml sql` は read-only、INSERT / UPDATE / DELETE は禁止）
- metric / substrate stack（Semantic Layer 議論、後で再検討）
- ORM / query builder の導入（SQL を thin に組み立てる）
- `meml search` 等の convenience wrapper（`meml sql` + `meml_embed` で代用、CLI surface を sharp に保つ）

## Technical Considerations

### 既存の前提（AGENTS.md より）

- Runtime: Bun + TypeScript
- DB: DuckDB + vss extension（`@duckdb/node-api`）
- Embedding: llama.cpp (llama-server) + bge-m3（default、1024 dim / 多言語）。engine は interface 化し差し替え可能（Ollama / OpenAI 等）
- 設計思想: Source-agnostic schema / Local-first / Unix-native / Build wide as tool, productize narrow

### この PRD で確立する設計

#### Schema

```sql
CREATE TABLE memory (
  id            TEXT PRIMARY KEY,        -- UUID v7 (内部 surrogate)
  source        TEXT NOT NULL,           -- "md" | "rss" | ...
  source_id     TEXT NOT NULL,           -- source 内で canonical な identity
  url           TEXT,                    -- 表示用（pull 系は URL、push 系は NULL）
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,           -- 生本文
  author        TEXT,                    -- 共通: 著者（push 系 md は user 自身）
  tags          TEXT[],                  -- 共通: タグ
  sourced_at    TIMESTAMP,               -- 共通: source 側の代表時刻 (best-effort)
  metadata      JSON,                    -- source 固有の raw 全部
  created_at    TIMESTAMP NOT NULL,      -- 初回 ingest 時刻
  updated_at    TIMESTAMP NOT NULL,      -- 最終 ingest 時刻 (再 add で更新)
  UNIQUE(source, source_id)
);

CREATE TABLE memory_chunks (
  id              TEXT PRIMARY KEY,        -- UUID v7
  memory_id       TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  chunk_index     INTEGER NOT NULL,
  content         TEXT NOT NULL,
  embedding       FLOAT[1024],             -- bge-m3 (llama-server)
  embedding_model TEXT NOT NULL,           -- 生成 model (混在検知、例 "bge-m3")
  UNIQUE(memory_id, chunk_index)
);
```

`source_id` を全 source の canonical identity として使う（AGENTS.md の `UNIQUE(source, url)` 設計を `UNIQUE(source, source_id)` に変更）。

#### CLI 設計の philosophy

- **raw SQL を agent との唯一のインターフェース** にする。CLI は thin、動的 SQL 組み立て（template literal + parameterized query）、ORM / query builder 不使用
- agent は `meml schema` で schema を引き、`meml sql` で query を直接書ける
- semantic search は SQL 内の **`meml_embed('text')`** として表現（CLI 側 preprocessor が literal を embed して bind 置換、UDF 登録ではない）。専用の `meml search` command は持たない

#### CLI 一覧

```
meml init [--vault PATH]                       # vault / DB / extension 初期化
meml add <path> [--title TITLE] [--dry-run]    # md ingest
meml remove <path>                             # 誤 ingest / orphan の削除
meml sql "<query>" [--json|--csv|--table]      # read-only raw SQL (- で stdin)
meml schema [--json]                           # schema export
```

`search` / `recent` / `get` 等の convenience は **持たない**（全部 SQL で書く）。

#### Vault / DB の格納

- Default vault: `~/.meml/`（`--vault` で override 可能）
- DB file: `<vault>/meml.duckdb`
- `meml init` で vault directory 作成 + DB 初期化 + vss extension load + schema migration

#### 失敗時 atomicity

- file 読み取り失敗時は exit code 非 0、stderr にエラー、DB は変更しない
- 1 file の ingest は transaction で wrap

## User Stories

### US-001: 環境を初期化する

**説明:** 個人ユーザー が meml を初めて使う時、vault と DB を作りたい。なぜなら 何もない状態から ingest を始められないため。

**受け入れ条件:**
- [ ] `meml init` で `~/.meml/` directory が作成される
- [ ] `~/.meml/meml.duckdb` に schema（`memory` / `memory_chunks` テーブル）が作成される
- [ ] DuckDB vss extension が load され、`array_cosine_similarity` 等の関数が使える
- [ ] 既に初期化済みの状態で `meml init` を再実行しても安全（idempotent）
- [ ] `meml init --vault ~/mymeml` で別 path を指定できる

### US-002: md memo を取り込む

**説明:** 個人ユーザー が ローカルの md memo を meml に取り込みたい。なぜなら 取り込まないと agent から引けず、memory layer として機能しないため。

**受け入れ条件:**
- [ ] `meml add ~/notes/foo.md` で memory 行が 1 件作成される
- [ ] `meml add ~/notes/foo.md --title "X"` で title が "X" になる
- [ ] `--title` 無しで file 先頭に `# Heading` があれば title が "Heading" になる
- [ ] `--title` も第 1 H1 も無ければ title が `foo`（拡張子除いた filename）になり、warn が stderr に出る
- [ ] 取り込み完了時に作成された memory id が stdout に出力される
- [ ] content / embedding が DB に書き込まれる
- [ ] 同じ path で再 add すると、既存行が UPSERT される（content / embedding / metadata / title / sourced_at / updated_at 更新、created_at は保持）
- [ ] file 読み取り失敗時は exit code 非 0、stderr にエラー、DB は変更しない

### US-003: schema を agent に教える

**説明:** Agent が meml の schema を知って SQL を組み立てたい。なぜなら schema を知らないと `meml sql` で正しい query が書けないため。

**受け入れ条件:**
- [ ] `meml schema --json` で table / column / 型 / 制約 が JSON で返る
- [ ] vss extension の関数（`array_cosine_similarity` 等）と `meml_embed`（preprocessor 疑似関数）が schema export に含まれる
- [ ] 人間向けに `meml schema`（`--json` なし）で table 形式の表示が出る

### US-004: raw SQL で query する

**説明:** Agent が DuckDB の表現力を使って自由に query したい。なぜなら 集計 / window function / 複雑な JOIN を CLI args では表現できないため。

**受け入れ条件:**
- [ ] `meml sql "SELECT * FROM memory LIMIT 5" --json` で結果が JSON 配列で返る
- [ ] `meml sql` 内で `meml_embed('text')` が使え、`array_cosine_similarity` と組み合わせて semantic search ができる
- [ ] INSERT / UPDATE / DELETE / CREATE / DROP / ALTER 等の書き込み系 SQL は拒否され、exit code 非 0 で stderr に明示エラーが出る
- [ ] `COPY ... TO` / `INSTALL` / `LOAD` / `ATTACH` 等の副作用系、および複数 statement も拒否される
- [ ] 出力形式は `--json` / `--csv` / `--table`（default: table）

### US-005: 既存の memo を bulk 取り込みする

**説明:** 個人ユーザー が 既存に書き溜めた数十件の md memo をまとめて取り込みたい。なぜなら 1 件ずつ手で取り込むのは現実的でないため。

**受け入れ条件:**
- [ ] shell ループ（例: `find ~/path -name '*.md' | xargs -I{} meml add {}`）で複数 file を取り込める
- [ ] 一部 file が失敗しても、残りの取り込みは継続される（個別失敗が bulk 全体を停止しない）
- [ ] 取り込み後、`meml sql "SELECT count(*) FROM memory WHERE source='md'"` で件数が確認できる

## Functional Requirements

### 基盤

1. `meml init [--vault PATH]` で vault directory 作成、DuckDB 初期化、vss extension load、schema 作成を行う。冪等（再実行で壊れない）
2. Default vault は `~/.meml/`、DB file は `<vault>/meml.duckdb`
3. Schema は AGENTS.md 準拠（`source_id` を canonical identity として `UNIQUE(source, source_id)`）
4. embedding pipeline: llama-server + bge-m3（1024 dim）。`memory.content` を chunk 分割し `memory_chunks` に格納、各 chunk に `embedding_model` を記録
5. `meml_embed('text')` を preprocessor で実装: `meml sql` が SQL 中の literal を embed して `$qvec_N` bind param に置換（UDF 登録ではない。行ごと HTTP 評価リスクと read-only 衝突を避ける、詳細は dd）

### CLI

6. `meml add <path> [--title TITLE] [--dry-run]` で `.md` 拡張子のファイルを取り込み、`memory` 行を 1 件作成。基本動作:
   - `source = "md"`、`source_id = realpath`（制御文字を拒否し symlink / 相対 / `..` を正規化）
   - `title` = `--title` → 第 1 H1 (`# ...`) → filename（拡張子除く、ここに落ちた時のみ warn を stderr）の順
   - `content` = file 全文（frontmatter / hashtag parse なし、生で保存）
   - `sourced_at` = mtime、`created_at` = 初回 ingest、`updated_at` = 今回 ingest
   - `author` = config の user identity（push 系 md は user 自身）、`tags` / `url` = NULL
   - `metadata` = `{ file_path, mime_type, size_bytes, mtime, ctime }`
   - chunk ごとに `embedding_model`（例 "bge-m3"）を記録
   - 同じ `source_id` で再 add すると UPSERT（`updated_at` を更新、`created_at` は保持）
   - 取り込みは transaction で atomic、失敗時は DB 変更なし
   - `--dry-run` 時は DB を変更せず、抽出される title / sourced_at / chunk 数 を JSON で返す（embedding は生成せず server 疎通のみ確認）
7. `meml sql "<query>" [--json|--csv|--table]` で read-only SQL を実行。`-` で stdin から SQL を読む。**単一 statement + SELECT/WITH allowlist** で実行し、`COPY`/`ATTACH`/`INSTALL`/`LOAD`/`CREATE`/`CALL`/`PRAGMA` や書き込み系は read_only connection + parser で二段拒否
8. `meml remove <path>` で realpath から source_id を解決し、該当 `memory` 行と chunks（CASCADE）を削除。read-only SQL では消せない誤 ingest / rename orphan の掃除用
9. `meml schema [--json]` で table / column / 制約 / vss 関数を出力

### 出力 / エラー

10. 出力 default は stdout の TTY 判定: 非 TTY (pipe / agent) なら JSON、TTY (人間) なら table。`--json` / `--csv` / `--table` で override、`MEML_OUTPUT=json` env でも固定可
11. CLI 失敗時は exit code 非 0、stderr に固定 shape の構造化エラー `{"error": {"code", "message", "hint"}}`（`code` で分岐、`hint` に復旧手順）。stdout には不完全な結果を出さない
12. `--json` 出力は agent parse 可能な JSON Array / Object

## Design Considerations

- **CLI は thin / 動的 SQL**: ORM / query builder を入れない。SQL string composition + parameterized query
- **meml_embed は preprocessor 方式**: `meml sql` が SQL 中の `meml_embed('<literal>')` を見つけ、CLI 側で 1 回 embed して `$qvec_N` bind param に置換してから DuckDB に渡す。UDF を第一候補にしない理由は行ごと HTTP 評価リスクと read-only connection 衝突（詳細は dd）。literal の precompute のみ対応
- **書き込み禁止の実装**: read_only mode（DB 書き込み禁止）だけでは `COPY TO` / `INSTALL` / `ATTACH` 等の副作用が残るので、read_only connection + statement allowlist（単一 statement + SELECT/WITH のみ）の二段で守る
- **拡張性**: 同じ `meml add` で後続の PDF / 画像も dispatch（extension / mime type 判定）できる構造にしておく。Phase 1 では `.md` のみ受け付ける
- **vault は user-owned**: meml は file 本体を所有しない、absolute path で参照のみ

## Success Metrics

- `meml init` → 既存の `~/src/github.com/wwwyo/me/daily/*/memo.md` を shell ループで bulk 取り込みでき、全 file が memory table に入る
- `meml sql "SELECT title, sourced_at FROM memory WHERE source='md' AND sourced_at > now() - INTERVAL 30 DAY ORDER BY sourced_at DESC"` で構造化 query が動く
- `meml sql "SELECT m.title, array_cosine_similarity(c.embedding, meml_embed('AI')) AS score FROM memory m JOIN memory_chunks c ON c.memory_id = m.id ORDER BY score DESC LIMIT 5"` で SQL 内 semantic search が動く
- agent（Claude Code）が `meml schema` を context として読み、上記 SQL を自分で組み立てて実行できる
