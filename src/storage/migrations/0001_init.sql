-- 0001_init: baseline schema (memory + memory_chunks).
--
-- Migrations are immutable historical records: once shipped, this file must NOT be edited
-- (schema changes go in a new numbered migration). Therefore values that elsewhere derive
-- from config (e.g. EMBED_DIM) are written as literals here on purpose — `FLOAT[1024]` is the
-- bge-m3 dimension at the time this baseline was created.
--
-- The baseline alone uses `IF NOT EXISTS` so adopting the migration runner over a pre-existing
-- (pre-runner) dev DB is non-breaking. Later migrations use plain DDL applied exactly once.

CREATE TABLE IF NOT EXISTS memory (
  id          TEXT PRIMARY KEY,        -- UUID v7 (internal surrogate)
  source      TEXT NOT NULL,           -- "md" | "rss" | ...
  source_id   TEXT NOT NULL,           -- canonical within source (md = realpath)
  url         TEXT,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  author      TEXT,
  tags        TEXT[],
  sourced_at  TIMESTAMPTZ,             -- source-side representative time (UTC instant)
  metadata    JSON,                    -- source-specific raw
  created_at  TIMESTAMPTZ NOT NULL,    -- first ingest
  updated_at  TIMESTAMPTZ NOT NULL,    -- last ingest (updated on re-add)
  UNIQUE (source, source_id)
);

CREATE TABLE IF NOT EXISTS memory_chunks (
  id              TEXT PRIMARY KEY,
  memory_id       TEXT NOT NULL,       -- logical (app-enforced) reference, not a DuckDB FK
  chunk_index     INTEGER NOT NULL,
  content         TEXT NOT NULL,
  embedding       FLOAT[1024],         -- bge-m3 fixed dimension
  embedding_model TEXT NOT NULL,       -- generation model, for mix detection
  UNIQUE (memory_id, chunk_index)
);
