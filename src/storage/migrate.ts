import type { DuckDBConnection } from "@duckdb/node-api";
import { MemlError } from "../errors.ts";
import { MIGRATIONS } from "./migrations/index.ts";

// Apply pending migrations in order, each in its own transaction, recording applied versions in
// schema_migrations. Idempotent: already-applied migrations are skipped, so re-running (e.g. every
// `meml init`) is safe. Migrations are immutable once shipped — schema changes go in a new file.
export async function migrate(conn: DuckDBConnection): Promise<void> {
  await conn.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL
    )
  `);

  const res = await conn.runAndReadAll("SELECT version FROM schema_migrations");
  const applied = new Set(res.getRowObjectsJson().map((r) => String(r.version)));

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await conn.run("BEGIN TRANSACTION");
    try {
      // conn.run executes a multi-statement SQL string; the whole migration is one transaction.
      await conn.run(m.sql);
      await conn.run("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, now())", {
        1: m.version,
      });
      await conn.run("COMMIT");
    } catch (e) {
      await conn.run("ROLLBACK").catch(() => {});
      throw new MemlError(
        "IO_ERROR",
        `migration ${m.version} failed: ${(e as Error).message}`,
        "The DB was left unchanged for this migration. Fix the migration or report the error.",
      );
    }
  }
}
