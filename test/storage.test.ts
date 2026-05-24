import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBArrayType, FLOAT } from "@duckdb/node-api";
import { EMBED_DIM, EMBED_MODEL } from "../src/config.ts";
import { type Db, openDb } from "../src/storage/db.ts";
import { migrate } from "../src/storage/migrate.ts";
import { type MemoryInput, removeBySourceId, upsertMemory } from "../src/storage/repo.ts";

const FLOAT_ARRAY = new DuckDBArrayType(FLOAT, EMBED_DIM);

// A vector whose FIRST element is integer-valued 0 — the case that DuckDB's arrayValue type
// inference would truncate to all-zeros. The repo uses explicit FLOAT bind, so it must survive.
function vec(seedIndex: number): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  v[seedIndex] = 1;
  v[seedIndex + 1] = 0.5;
  return v;
}

function mem(sourceId: string, title: string, content: string): MemoryInput {
  return {
    source: "md",
    sourceId,
    url: null,
    title,
    content,
    author: "tester",
    tags: null,
    sourcedAtMs: Date.UTC(2026, 0, 1),
    metadata: { file_path: sourceId },
  };
}

let dir: string;
let db: Db;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "meml-store-"));
  db = await openDb(dir, "read-write");
  await migrate(db.conn);
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function count(table: "memory" | "memory_chunks"): Promise<number> {
  const r = await db.conn.runAndReadAll(`SELECT count(*) AS n FROM ${table}`);
  return Number((r.getRowObjectsJson()[0] as { n: string }).n);
}

describe("repo", () => {
  test("upsert inserts memory + chunks with non-truncated float embeddings", async () => {
    const now = Date.UTC(2026, 1, 1);
    // Leading element is integer-valued 0; later element is fractional. arrayValue() inference
    // would truncate the fraction to 0; explicit FLOAT bind must preserve 0.5.
    const leadingZero = new Float32Array(EMBED_DIM);
    leadingZero[0] = 0;
    leadingZero[1] = 0.5;
    const id = await upsertMemory(
      db.conn,
      mem("/notes/a.md", "Alpha", "alpha body"),
      [{ index: 0, content: "alpha body", embedding: leadingZero, model: EMBED_MODEL }],
      now,
    );
    expect(id).toBeTruthy();
    expect(await count("memory")).toBe(1);
    expect(await count("memory_chunks")).toBe(1);

    const r = await db.conn.runAndReadAll("SELECT embedding[1] AS e0, embedding[2] AS e1 FROM memory_chunks");
    const row = r.getRowObjectsJson()[0] as { e0: number; e1: number };
    expect(row.e0).toBe(0);
    expect(row.e1).toBeCloseTo(0.5, 5); // would be 0 if truncated
  });

  test("re-upsert preserves created_at, advances updated_at, replaces chunks", async () => {
    const first = await db.conn.runAndReadAll("SELECT id, created_at FROM memory WHERE source_id = '/notes/a.md'");
    const before = first.getRowObjectsJson()[0] as { id: string; created_at: string };

    const later = Date.UTC(2026, 2, 1);
    const id2 = await upsertMemory(
      db.conn,
      mem("/notes/a.md", "Alpha v2", "alpha body updated"),
      [
        { index: 0, content: "c0", embedding: vec(0), model: EMBED_MODEL },
        { index: 1, content: "c1", embedding: vec(10), model: EMBED_MODEL },
      ],
      later,
    );
    expect(id2).toBe(before.id); // id preserved on conflict

    const after = await db.conn.runAndReadAll(
      "SELECT title, created_at, updated_at, (updated_at > created_at) AS advanced FROM memory WHERE id = $1",
      { 1: id2 },
    );
    const row = after.getRowObjectsJson()[0] as { title: string; created_at: string; advanced: boolean };
    expect(row.title).toBe("Alpha v2");
    expect(row.created_at).toBe(before.created_at);
    expect(row.advanced).toBe(true);
    // chunks replaced (now 2 for this memory), no orphans
    expect(await count("memory_chunks")).toBe(2);
    expect(await count("memory")).toBe(1);
  });

  test("semantic ranking via array_cosine_similarity with bound query vector", async () => {
    await upsertMemory(
      db.conn,
      mem("/notes/b.md", "Beta", "beta body"),
      [{ index: 0, content: "beta", embedding: vec(500), model: EMBED_MODEL }],
      Date.UTC(2026, 2, 2),
    );
    // query vector close to /notes/a.md chunk 0 (vec(0))
    const stmt = await db.conn.prepare(`
      SELECT m.title, array_cosine_similarity(c.embedding, $q) AS score
      FROM memory m JOIN memory_chunks c ON c.memory_id = m.id
      ORDER BY score DESC
    `);
    stmt.bindArray(stmt.parameterIndex("q"), Array.from(vec(0)), FLOAT_ARRAY);
    const r = await stmt.runAndReadAll();
    const rows = r.getRowObjectsJson() as unknown as { title: string; score: number }[];
    expect(rows[0]!.title).toBe("Alpha v2");
    expect(rows[0]!.score).toBeGreaterThan(rows[rows.length - 1]!.score);
  });

  test("remove deletes memory + its chunks, returns id; missing returns null", async () => {
    const memCountBefore = await count("memory");
    const id = await removeBySourceId(db.conn, "md", "/notes/a.md");
    expect(id).toBeTruthy();
    expect(await count("memory")).toBe(memCountBefore - 1);
    // a.md had 2 chunks; only b.md's 1 chunk remains
    expect(await count("memory_chunks")).toBe(1);

    const missing = await removeBySourceId(db.conn, "md", "/notes/does-not-exist.md");
    expect(missing).toBeNull();
  });
});
