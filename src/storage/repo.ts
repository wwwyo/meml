import { DuckDBArrayType, type DuckDBConnection, FLOAT } from "@duckdb/node-api";
import { EMBED_DIM } from "../config.ts";

const FLOAT_ARRAY = new DuckDBArrayType(FLOAT, EMBED_DIM);

export interface MemoryInput {
  source: string;
  sourceId: string;
  url: string | null;
  title: string;
  content: string;
  author: string | null;
  tags: string[] | null;
  sourcedAtMs: number | null;
  metadata: unknown;
}

export interface ChunkInput {
  index: number;
  content: string;
  embedding: Float32Array;
  model: string;
}

const toMicros = (ms: number) => BigInt(Math.round(ms)) * 1000n;

// UPSERT memory by (source, source_id). Preserves id + created_at on conflict; replaces all
// chunks. Caller wraps in a transaction. Returns the (existing or new) memory id.
export async function upsertMemory(
  conn: DuckDBConnection,
  m: MemoryInput,
  chunks: ChunkInput[],
  nowMs: number,
): Promise<string> {
  const newId = Bun.randomUUIDv7();
  const stmt = await conn.prepare(`
    INSERT INTO memory
      (id, source, source_id, url, title, content, author, tags, sourced_at, metadata, created_at, updated_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, make_timestamp($9), $10::JSON, make_timestamp($11), make_timestamp($12))
    ON CONFLICT (source, source_id) DO UPDATE SET
      url        = excluded.url,
      title      = excluded.title,
      content    = excluded.content,
      author     = excluded.author,
      tags       = excluded.tags,
      sourced_at = excluded.sourced_at,
      metadata   = excluded.metadata,
      updated_at = excluded.updated_at
    RETURNING id
  `);
  stmt.bindVarchar(1, newId);
  stmt.bindVarchar(2, m.source);
  stmt.bindVarchar(3, m.sourceId);
  m.url === null ? stmt.bindNull(4) : stmt.bindVarchar(4, m.url);
  stmt.bindVarchar(5, m.title);
  stmt.bindVarchar(6, m.content);
  m.author === null ? stmt.bindNull(7) : stmt.bindVarchar(7, m.author);
  m.tags === null ? stmt.bindNull(8) : stmt.bindList(8, m.tags);
  m.sourcedAtMs === null ? stmt.bindNull(9) : stmt.bindBigInt(9, toMicros(m.sourcedAtMs));
  stmt.bindVarchar(10, JSON.stringify(m.metadata ?? null));
  stmt.bindBigInt(11, toMicros(nowMs));
  stmt.bindBigInt(12, toMicros(nowMs));
  const res = await stmt.runAndReadAll();
  const memoryId = String(res.getRowObjectsJson()[0]!.id);

  await conn.run("DELETE FROM memory_chunks WHERE memory_id = $1", { 1: memoryId });

  if (chunks.length > 0) {
    const cstmt = await conn.prepare(`
      INSERT INTO memory_chunks (id, memory_id, chunk_index, content, embedding, embedding_model)
      VALUES ($1, $2, $3, $4, $5, $6)
    `);
    for (const c of chunks) {
      cstmt.clearBindings();
      cstmt.bindVarchar(1, Bun.randomUUIDv7());
      cstmt.bindVarchar(2, memoryId);
      cstmt.bindInteger(3, c.index);
      cstmt.bindVarchar(4, c.content);
      cstmt.bindArray(5, Array.from(c.embedding), FLOAT_ARRAY);
      cstmt.bindVarchar(6, c.model);
      await cstmt.run();
    }
  }
  return memoryId;
}

// Delete the memory row and its chunks. DuckDB FKs lack ON DELETE CASCADE, so chunks are
// deleted first (FK is RESTRICT). Wrapped in a transaction by the caller. Returns id, or null.
export async function removeBySourceId(
  conn: DuckDBConnection,
  source: string,
  sourceId: string,
): Promise<string | null> {
  const found = await conn.runAndReadAll(
    "SELECT id FROM memory WHERE source = $1 AND source_id = $2",
    { 1: source, 2: sourceId },
  );
  const rows = found.getRowObjectsJson();
  if (rows.length === 0) return null;
  const id = String(rows[0]!.id);
  await conn.run("DELETE FROM memory_chunks WHERE memory_id = $1", { 1: id });
  await conn.run("DELETE FROM memory WHERE id = $1", { 1: id });
  return id;
}
