# Design Doc: local-markdown-ingest

## Objectives

ローカル markdown ファイルを `meml add <path>` で取り込み、agent が `meml sql` 経由で raw SQL を使って構造化 + semantic の両方の query をかけられる状態にする。あわせて、後続 source plugin (PDF / 画像 / RSS 等) が乗る基盤 (DuckDB schema / embedding pipeline / CLI 骨格) を確立する。

**Not Goals**:

- frontmatter / inline hashtag のパース (md だけ特別扱いしない原則)
- LLM による title / signals 抽出 (Phase 0 では入れない、`--title` arg + filename fallback)
- `meml search` / `recent` / `get` 等の convenience wrapper (raw SQL で済ませる)
- 書き込み系 SQL の許可 (read-only)
- metric / substrate stack (semantic layer 議論、Phase 後ろで再検討)
- watched folder / 自動取り込み (手動 only)

PRD: [./prd.md](./prd.md)

## Background

meml は個人の input (RSS / GitHub / Slack / local file 等) を local DuckDB に集約し、agent から **raw SQL で query** できる memory layer。本 DD はその第一実装として local markdown ingest を扱う。長期的には wwwyo/me リポジトリで管理している daily memo / wiki / todo を meml に migration する流れの起点。

設計議論の本体は [wwwyo/me — wiki/syntheses/data-platform-architecture.md](https://github.com/wwwyo/me/blob/main/wiki/syntheses/data-platform-architecture.md)。本 DD に効く前提を再掲する:

- **個人スケールゆえ substrate stack 不要**: organizational continuity も owner review も無いので、定義の凍結層 (metric / substrate) は当面入れない。raw memory + embedding で agent が読めれば十分
- **dual representation を 1 stack で**: DuckDB 1 つで structured (SQL) + vector (vss extension) を同じ query で JOIN できるので、別ベクトル DB は不要
- **CLI が agent との boundary**: agent が DuckDB を直接叩くと vault path / extension load / UDF 登録の責務が agent 側に散る。`meml` CLI を介すことで prelude を CLI に閉じ込める

## System Overview

```
                    ┌─────────────────────────────┐
                    │  DuckDB (vault/meml.duckdb) │
                    │  + vss extension            │
                    │  + meml_embed UDF           │
                    │  memory ──chunk+embed──▶    │
                    │            memory_chunks    │
                    └──────▲──────────────▲───────┘
          add: write (ingest)            │ sql: read-only
                    │                     │
        ┌───────────┴─────────────────────┴──────────────┐
        │  meml CLI : init / add / remove / sql / schema  │
        │   └ Source plugins (Phase 0: md):               │
        │       file 読み込み / 共通 column への mapping    │
        └───────────────────────┬─────────────────────────┘
                                 ▲
                                 │
                    Agent (Claude / Cursor / shell)
```

- **meml CLI**: agent との唯一の境界。`add` で ingest、`sql` で raw SQL、`schema` で discovery
- **DuckDB**: 1 stack で structured + vector を持つ。`meml_embed(text)` UDF で SQL 内 semantic search を表現
- **Source plugin** (Phase 0 では md のみ): file から `memory` 行への mapping を担う

## Detailed Design

本セクションは **議論したい論点のみ** を扱う。素朴に書ける実装 (file 読み込み / commander の subcommand routing / DuckDB connection 開閉 / 標準的な migration runner / 出力フォーマット切り替え 等) は本 DD では扱わず、実装時にコードレビューで判断する。

### CLI を agent との唯一の境界にする

raw SQL を expose するなら agent に DuckDB を直接渡してもよさそうに見えるが、それでは agent が vault path 解決 / vss extension load / `meml_embed` UDF 登録の全てを毎回再現する責務を負う。これは agent 言語 / 実行環境ごとに散らばって運用が破綻する。

代わりに `meml sql` を境界として置き、CLI 側で DB prelude (vault open / extension load / UDF 登録) を完結させる。agent は `meml schema` で schema を引いて `meml sql "<query>"` を投げるだけで済む。raw SQL の柔軟性を保ったまま prelude の責務を CLI に押し込めるのが核心。

`search` / `recent` / `get` のような convenience wrapper を持たない判断もここから派生する。convenience を一度入れると「SQL では書けるが convenience では書けない」境界を毎回引き直すことになり CLI 仕様が肥大化する。SQL で書ける以上、convenience は YAGNI として持たない。

### source_id を全 source の canonical identity にする

`UNIQUE(source, url)` で identity を取る素朴案は md のように URL を持たない source で破綻する (SQL の UNIQUE は NULL を抜ける)。`source_id TEXT NOT NULL` を導入し、`UNIQUE(source, source_id)` を identity にする。

- md: `source_id = ファイルの realpath` (symlink / 相対 / `..` を正規化した絶対パス)
- RSS: `source_id = feed item GUID` (無ければ URL fallback)
- GitHub PR: `source_id = "owner/repo/pull/N"`
- Slack: `source_id = channel + message_ts` 等

`url` は表示用の補助 column に降格する。代替案として「web URL のある source は url、ない source は source_id」と `COALESCE(url, source_id)` で分岐させる手もあるが、agent から見た名前空間が二重になり混乱するため採らない。

md の path を identity にする以上、file を rename すると source_id が変わり別 memory になり、古い path の行が orphan として残る。代替の同一性追跡 (content hash / inode / watched folder) はどれも個人ツールには脆い/過剰 (hash は memo 編集で不安定、inode は FS 依存・コピーで壊れる、watch は手動 only 方針に反する) ので、**rename orphan は許容**し `meml remove <path>` で手動掃除する (手動 ingest なら orphan は稀で実害は小さい)。

### 共通 column と metadata JSON のハイブリッド

source 固有の構造を `metadata` JSON に raw のまま入れる方針は raw 優先の原則と整合するが、それだけだと横断 query (例「AI tag のもの全部」) が source ごとに UNION + 異なる JSON path で書く地獄になる。

横断 query 頻出 axis (`tags` / `author` / `sourced_at`) だけ共通 column に持ち、それ以外は `metadata` JSON に押し込む。**mapping は plugin 責務**にする: 共通 column のキー集合は中央で型定義し、各 plugin が source 概念 → 共通 column の正規化 mapping を実装で持つ。中央にハードコード表を置くと source 追加のたびに表を編集することになり破綻するので避ける。

| 共通 column | RSS | GitHub | md |
|---|---|---|---|
| `tags` | `categories` | `labels` | NULL (frontmatter parse しない) |
| `author` | `creator` | `user.login` | **user 自身** (config identity) |
| `sourced_at` | `pubDate` | `created_at` | file mtime |

(上表は各 plugin が実装する mapping の例。中央に表として持つのではなく plugin のコードに置く。)

共通 column は **3 つで開始**。増やしすぎると schema 議論が再燃するので、横断 query で頻繁に必要になった axis を 1 個ずつ migration で追加する方針。

値は plugin が軽量正規化 (trim / lowercase 程度) した生値を入れるに留める。表記ゆれの名寄せ (例「AI ⇄ artificial-intelligence ⇄ 機械学習」を canonical に束ねる) を ingest 時にやると、ingest が pure でなくなり、早すぎる canonical 確定が後で覆せなくなる。**名寄せは ontology として Phase 3+ で後付け**する: memory には生値を残し、`alias → canonical` の lookup を別途持って read-time JOIN か lazy な再構築 command で解決する。cross-source のデータが溜まって初めて「何を束ねるべきか」が見えるので、md だけの Phase 0 では入れない。

### md だけ frontmatter / hashtag を parse しない

frontmatter parse は markdown 固有の慣習で、PDF / 画像 / RSS / Slack には存在しない。md だけ特別扱いすると、後で source 追加するたびに「これは特別扱いするのか」議論が再燃する。同様に inline `#hashtag` も markdown / Twitter スタイル特有の構文で、独自構文は採用しない。

代わりに **file system metadata から共通 column に best-effort で map** する: `sourced_at` は mtime、`author` は config の user identity (push 系 md は user 自身が書いたものと見なす)、それ以外 (`tags` / `url`) は NULL。`title` は `--title` → 第 1 H1 → filename の順で別途扱う (次節)。frontmatter / hashtag は parse しないが、第 1 H1 は「見出しの最初の 1 行」を title fallback に使うだけで、構文 parse とは別物。

### title は plugin 責務 (md は --title → 第 1 H1 → filename)

push 系 source (md / PDF / 画像) には「source 自体が提供する単一の title」が無い。title 抽出は **plugin 責務**にする (共通 column mapping と同じ思想): 各 plugin が自分の source に最適な best-effort 抽出を持ち、中央では「title は最終的に必ず埋まる」ことだけ保証する。

md plugin の優先順位は `--title` arg → 第 1 H1 (`# ...`) → filename (拡張子除く):

| 候補 | 位置づけ |
|---|---|
| `--title` arg | 最優先。user が明示したものを尊重 |
| 第 1 H1 | md plugin の fallback。markdown では H1 が事実上の title。これは md plugin に閉じた title 抽出であって frontmatter parse とは別 (見出しの最初の 1 行を読むだけ) |
| filename | 最後の fallback。`note1.md` 等で無意味でも最低限埋まる。ここに落ちた時だけ stderr に warn |
| LLM 推論 | ingest が外部 API 依存になるので採らない。将来 `meml extract --signal title` の lazy command で後付け |

第 1 H1 抽出は md plugin に閉じる。PDF / 画像 plugin は別の best-effort (PDF metadata の title 等) を持てばよく、「md だけ特別」にはならない — 各 plugin が source 特性に応じた抽出を持つのが原則。

### 再 add は UPSERT (snapshot は持たない)

memo は編集が常態。同じ source_id で再 add → 既存行を上書き (content / embedding / metadata / title / sourced_at すべて更新) する UPSERT を default にする。

append-only snapshot は「過去の自分が書いた版」を残せる利点があるが、retrieval 時の dedupe コストと storage 圧迫を Phase 0 のスコープに入れない。snapshot 性が欲しくなった時点で、元 file を git 管理することで代替できる (実 file は user-owned なので、user の git に任せる)。

### embedding は llama.cpp (llama-server) + bge-m3 (bun では native binding を避ける)

embedding model に多言語対応の bge-m3 (1024 次元) を使う。取り込む対象が日本語の memo / wiki なので、英語専用モデル (BGE-small-en 等) では日本語の semantic search が成立しない (クロスリンガルが効かず、日本語の embed 品質も出ない)。

実行ランタイムは llama.cpp の `llama-server` を default にする。理由は bun ランタイムであること: fastembed (onnxruntime-node) や node-llama-cpp は native addon で、bun での安定動作が未保証 (踏んでみないと分からない地雷)。llama-server は純 HTTP なので bun の `fetch` で叩くだけで済み、native binding の互換性問題を回避できる。`-hf <bge-m3 GGUF>:Q8_0` で model を HF から自動 DL し、`--embeddings` で embedding 専用 server として常駐させ、`/v1/embeddings` (OpenAI 互換) に POST する。Ollama は使わない: 中身は同じ llama.cpp だが、ラッパーで pooling / normalize / 量子化が隠れる。llama-server を直接使えば設定が透明で、依存も増えない (手元に既にある)。

代償は **server 常駐への依存**。`meml init` で接続を check し未起動なら明示エラー、cron fetch (Phase 3+) も server 常駐が前提になる。全部ローカルなので local-first は保たれるが「CLI 単体で完結」は崩れる。meml は server を spawn / 管理せず HTTP client に徹し、起動は user が行う (README に起動コマンドを書く)。このトレードオフを許容する。

embedding engine は `src/embedding` で `embed(texts): Promise<Float32Array[]>` の薄い interface に切り、llama-server 実装を default にする (将来 Ollama / OpenAI 等に差し替え可能、いずれも HTTP なので fetch 先が変わるだけ)。量子化は embedding 品質に効くので Q8_0 / F16 を選ぶ。bge-m3 は mean pooling (GGUF default に無ければ `--pooling mean`)。e5 系のような `query:` / `passage:` prefix は bge-m3 dense では基本不要。

### semantic search を SQL 内で表現する: `meml_embed`

semantic search を CLI 側で wrap する素朴案 (`meml search "..."`) では構造化 filter との組み合わせ表現力が弱い。SQL 内で `meml_embed('query')` を書ければ、構造化 + semantic + sort を 1 query で完全に書ける:

```sql
SELECT m.title,
       array_cosine_similarity(c.embedding, meml_embed('react server components')) AS score
FROM memory m JOIN memory_chunks c ON c.memory_id = m.id
WHERE m.source = 'md' AND m.sourced_at > now() - INTERVAL 7 DAY
ORDER BY score DESC LIMIT 5;
```

実装は **preprocessor 方式を第一候補**にする (DuckDB UDF ではなく)。`meml sql` が受け取った SQL を実行前にスキャンし、`meml_embed('<literal>')` を見つけたら CLI 側で 1 回だけ embedding 化 (llama-server に HTTP fetch)、結果の vector を `$qvec_N` bind param に置換してから DuckDB に投げる。

UDF を第一候補にしない理由: DuckDB の scalar UDF は **行ごとに評価され得る**。`meml_embed('query')` が literal でも optimizer が定数畳み込みする保証はなく、最悪 `memory_chunks` 全行で評価 → HTTP fetch が N 回走る。`meml_embed(column)` を許せば確定で全行 HTTP。さらに UDF 登録は connection に紐付くので read-only connection に登録できるか怪しく (embed が HTTP/async な点も絡む)、read-only enforcement と衝突する。preprocessor なら literal を 1 回 embed するだけで HTTP は必ず 1 回、UDF 登録も不要で read-only connection と衝突しない。

制約: preprocessor は **literal の precompute のみ** (`meml_embed(column)` のような動的引数は対象外)。semantic search の用途は「1 つの query 文字列を embed して全 chunk と比較」なので literal で足り、column embed は ingest 時にしか不要。任意位置で評価する UDF 方式が本当に要るユースケースが出たら、その時に async UDF サポートを検証して後付けする。

### read-only enforcement: read_only mode + statement allowlist の二段

`meml sql` は read-only。当初 DuckDB の read_only mode だけで足りると考えたが、それは **DB ファイルへの書き込み禁止**であって「副作用ゼロ」ではない。read_only mode でも `COPY (...) TO '/path'` (任意ファイル書き出し) / `INSTALL` / `LOAD` (拡張ロード) / `ATTACH` (別 DB 接続) / `read_csv('/etc/...')` (任意ファイル読み) が通る。agent が memo 内の悪意ある指示や hallucination でこれらを打つと防げない。

二段で守る:

1. **read_only connection で open** — DB engine が DB 書き込みを保証付きで拒否 (bypass 不可)
2. **statement allowlist** — `meml sql` 側で受け取った SQL を、(a) **単一 statement のみ** (複数 `;` 区切りを拒否、コメント trick も正規化して弾く)、(b) 先頭が `SELECT` / `WITH` のみ許可、(c) `COPY` / `ATTACH` / `INSTALL` / `LOAD` / `CREATE` / `CALL` / `PRAGMA` 等を拒否

`meml_embed` を preprocessor 方式 (前節) にしたことで UDF 登録が不要になり、read-write connection を別に持つ必要もない。agent query は read-only connection 一本で受けられる。

### agent-friendly な出力 / エラー

meml は agent が主クライアントなので、human DX より agent DX (予測可能性・機械可読・自己回復) を優先する。raw SQL (payload 第一級) / `meml schema` (自己記述) / read-only enforcement (入力ハードニングの核) は既に方針に含む。Phase 0 で加える点:

- **出力 default は TTY 判定**: stdout が TTY なら human 向け table、非 TTY (pipe / agent) なら JSON を default。`--json` / `--csv` / `--table` で override、`MEML_OUTPUT=json` env でも固定可 (agent 実行環境の揺れに強くする)。agent に毎回 `--json` を付けさせない
- **構造化エラー**: 失敗時は exit code 非 0 + stderr に固定 shape の JSON `{"error": {"code", "message", "hint"}}`。`code` で機械的に分岐でき、`hint` に復旧手順 (embedding server 未起動なら「llama-server を `--embeddings -hf ...` で起動せよ」等)。自由文だけだと agent が分岐しにくいので shape を固定する
- **`meml sql -`**: SQL を stdin から読む口を持つ。引数渡しは shell quoting (クォート / `$` / バッククォート) で壊れやすいので、agent には stdin 経路を勧める
- **`meml add --dry-run`**: 実際に書かず、抽出される title / sourced_at / chunk 数を JSON で返す。**embedding は生成せず server 疎通 (health) だけ確認**する (重い model を dry-run のたびに叩かない)。bulk ingest 前の検証用
- **`meml remove <path>`**: read-only SQL では消せない誤 ingest / rename orphan を消す唯一の write command。realpath で source_id を解決し memory + chunks (CASCADE) を削除
- **入力ハードニング**: `meml sql` は **単一 statement + SELECT/WITH allowlist** (read-only enforcement の節参照)。`meml add` の path は制御文字を拒否し realpath に正規化する (vault サンドボックスはしない — user-owned file をどこからでも add するのが正常動作)

見送る (Phase 0 外 / meml には過剰):

- **MCP surface**: まず Unix-native CLI で回す。raw SQL を MCP tool 化する需要が出たら後続で追加
- **レスポンス sanitize**: memo 本文の改変は本末転倒。出力を JSON 構造化して「これは `content` の値」と示すことで、データ側プロンプトインジェクションは agent 側の区別に委ねる
- **NDJSON ページネーション**: 個人スケールで巨大結果は稀。agent が SQL に `LIMIT` を書けば足りる

### Schema と議論ポイント

```sql
CREATE TABLE memory (
  id            TEXT PRIMARY KEY,        -- UUID v7 (内部 surrogate)
  source        TEXT NOT NULL,           -- "md" | "rss" | ...
  source_id     TEXT NOT NULL,           -- source 内で canonical
  url           TEXT,                    -- 表示用補助
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,           -- 生本文
  author        TEXT,                    -- 共通: 著者
  tags          TEXT[],                  -- 共通: タグ
  sourced_at    TIMESTAMP,               -- 共通: source 側の代表時刻 (best-effort)
  metadata      JSON,                    -- source 固有 raw 全部
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

議論ポイント:

- `id` は UUID v7 (`memory` / `memory_chunks` 共通)。時系列ソート可能で PK の挿入局所性が良い。canonical identity は `source_id` が担い `id` は内部 surrogate key (UPSERT 時は保持、新規 insert 時のみ生成)。v7 生成は bun 組み込みの `Bun.randomUUIDv7()` を使う (追加ライブラリ不要)
- `created_at` (初回 ingest) と `updated_at` (最終 ingest) を分ける。再 add (UPSERT) で `updated_at` のみ更新し初回時刻を失わない。`sourced_at` (source 側 mtime) とも別軸 — 「source で書かれた/更新された時刻」「最初に取り込んだ時刻」「最後に取り込んだ時刻」の 3 つは別物
- 将来 plugin 用の投機的 column (RSS 既読管理の `read_at`、summarizer の `summarized_at` 等) は **持たない**。Phase 0 で使わない column は schema ノイズになり、agent が `meml schema` を読んで SQL を組む時に混乱する。必要になった時点で migration runner で足す (NULL 許容の ADD COLUMN は安い)
- `ON DELETE CASCADE` で memory 削除時に chunks も削除。逆 (chunks 残し) を選ぶ理由が無いので明示
- `embedding FLOAT[1024]` の次元固定は bge-m3 (llama-server) に依存。別次元の model (OpenAI 1536 等) を opt-in で許す場合、別 column or 別 table が必要になるが、Phase 0 では 1024 固定で進める
- `memory_chunks.embedding_model` に生成 model 名を残す。model を変えると embedding 空間が変わり既存 vector との cosine 比較が無意味になるため、混在を検知できるようにする。dim は型 (`FLOAT[1024]`) に出るので column 化せず、pooling / chunker version までは Phase 0 では残さない (YAGNI)

## Tasks

[./prd.md](./prd.md) の User Stories に対応する。実装単位は以下 (依存順)。最初の実装ゴールはコア (md ingest + preprocessor query embed + read-only SELECT) で、vss の HNSW index 最適化や UDF 方式は本 Phase に入れずデータ量・需要が出てから後続で扱う:

0. **spike (最優先)**: Bun + `@duckdb/node-api` + vss extension + `FLOAT[1024]` の bind / `array_cosine_similarity` が通るか検証。`@duckdb/node-api` 自体が native addon なので、ここが Bun で動かないと全体が止まる (embedding の native binding 回避以前の前提)
1. CLI 骨格 + 依存追加 (commander / `@duckdb/node-api`、subcommand routing。embedding は llama-server HTTP なので追加 native 依存なし)
2. DuckDB connection layer + vault path 解決 (vss extension auto-install/load 含む)
3. Schema migration runner (冪等、`UNIQUE(source, source_id)` / `UNIQUE(memory_id, chunk_index)` を含む)
4. `meml init` command (llama-server 接続 check 含む)
5. Embedding pipeline (llama-server HTTP client wrapper + chunker、`embedding_model` 記録)
6. `meml add` md ingest (realpath 正規化、UPSERT で `updated_at` 更新、transaction wrap、atomic 失敗)
7. `meml remove <path>` (realpath で source_id 解決し memory + chunks を削除)
8. `meml schema` command (table / column / 制約 / vss 関数 を export)
9. `meml sql` 実行 (read_only connection + statement allowlist) + 出力 (TTY 判定 / `--json` / `--csv` / `--table`) + 構造化エラー
10. `meml_embed` preprocessor (SQL 中の literal を embed して `$qvec_N` に bind 置換)
11. Bulk ingest 互換性の integration test (per-file isolation、find/xargs シナリオ)
12. E2E QA: wwwyo/me daily memo を bulk ingest して全シナリオ完走を確認

## Security / Privacy

- DB / vault は user のローカル `~/.meml/` 配下に置く。directory permissions は 0700 (user-only)
- `meml sql` は read-only enforcement で破壊操作を拒否
- file ingest 時の absolute path は `metadata` に保存される (本人 machine 内のみ流通する想定)
- embedding は local llama-server が default (content は外部送信されない)。OpenAI 等の外部 API を opt-in で使う場合、API key 経由で外部に content を送信する旨を user に明示する責務がある

## Caveats

- **最大の未検証リスクは Bun + `@duckdb/node-api` の互換性** (native addon)。Tasks 0 の spike で最初に潰す。vss extension load / `FLOAT[1024]` bind / `array_cosine_similarity` まで通って初めて全体が成立する
- `meml_embed` は preprocessor 方式 (literal を CLI で embed して bind 置換) を第一候補にした。この方式では `meml_embed` を含む SQL は **`meml sql` 経由のみ** 動作する (DuckDB CLI で直接叩いても動かない)。UDF 方式 (任意位置評価) は行ごと HTTP 評価リスクと read-only connection 衝突があるため後送り
- bge-m3 (1024 次元、llama-server 経由) を embedding model に固定。chunker 戦略 (size / overlap) と pooling / 量子化は実装着手時に確定する。検索品質を後で見て差し替える可能性はある
- 共通 column は 3 つ (`author` / `tags` / `sourced_at`) で開始。横断 query の頻度を見て追加する方針だが、追加時は既存 row の backfill cost が発生する
- 共通 column の値の正規化・名寄せ (ontology: `alias → canonical` の解決) は本 PRD のスコープ外。cross-source データが溜まる Phase 3+ に **別 PRD で ontology 対応**する。本 PRD では plugin が軽量正規化した生値を入れるに留め、後から ontology を被せられる形 (生値を残す read-time / lazy resolution) を保つ
