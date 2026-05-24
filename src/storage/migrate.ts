import type { DuckDBConnection } from "@duckdb/node-api";
import { EMBED_DIM } from "../config.ts";

// Idempotent schema creation. Re-running is safe (CREATE TABLE IF NOT EXISTS).
// Timestamps are TIMESTAMPTZ (UTC instants) so comparisons with now() are correct in any
// session timezone; values are stored via `make_timestamp(micros) AT TIME ZONE 'UTC'`.
// Note: memory_chunks.memory_id is a logical (app-enforced) reference, NOT a DuckDB FOREIGN KEY.
// DuckDB's FK support cannot express ON DELETE CASCADE and errors on delete-then-reinsert /
// parent-delete patterns (our UPSERT re-add and remove flows). Integrity is maintained in code:
// chunks are always written/deleted atomically with their parent memory (see repo.ts).
export async function migrate(conn: DuckDBConnection): Promise<void> {
  await conn.run(`
    CREATE TABLE IF NOT EXISTS memory (
      id          TEXT PRIMARY KEY,
      source      TEXT NOT NULL,
      source_id   TEXT NOT NULL,
      url         TEXT,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      author      TEXT,
      tags        TEXT[],
      sourced_at  TIMESTAMPTZ,
      metadata    JSON,
      created_at  TIMESTAMPTZ NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL,
      UNIQUE (source, source_id)
    )
  `);

  await conn.run(`
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id              TEXT PRIMARY KEY,
      memory_id       TEXT NOT NULL,
      chunk_index     INTEGER NOT NULL,
      content         TEXT NOT NULL,
      embedding       FLOAT[${EMBED_DIM}],
      embedding_model TEXT NOT NULL,
      UNIQUE (memory_id, chunk_index)
    )
  `);
}
