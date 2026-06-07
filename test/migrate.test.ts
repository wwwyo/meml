import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, openDb } from "../src/storage/db.ts";
import { migrate } from "../src/storage/migrate.ts";
import { MIGRATIONS } from "../src/storage/migrations/index.ts";

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "meml-migrate-"));
  db = await openDb(dir, "read-write");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function tableExists(name: string): Promise<boolean> {
  const r = await db.conn.runAndReadAll(
    "SELECT count(*) AS n FROM information_schema.tables WHERE table_name = $1",
    { 1: name },
  );
  return Number((r.getRowObjectsJson()[0] as { n: string }).n) > 0;
}

async function appliedVersions(): Promise<string[]> {
  const r = await db.conn.runAndReadAll("SELECT version FROM schema_migrations ORDER BY version");
  return r.getRowObjectsJson().map((x) => String(x.version));
}

describe("migrate", () => {
  test("creates baseline tables and records the applied version", async () => {
    await migrate(db.conn);
    expect(await tableExists("memory")).toBe(true);
    expect(await tableExists("memory_chunks")).toBe(true);
    expect(await appliedVersions()).toEqual(MIGRATIONS.map((m) => m.version));
  });

  test("is idempotent: re-running applies nothing new and does not error", async () => {
    await migrate(db.conn);
    const first = await appliedVersions();
    await migrate(db.conn);
    await migrate(db.conn);
    expect(await appliedVersions()).toEqual(first);
  });

  test("baseline adoption: pre-existing tables (no schema_migrations) do not break", async () => {
    // Simulate a pre-runner DB: tables already exist, no tracking table.
    await db.conn.run("CREATE TABLE memory (id TEXT PRIMARY KEY)");
    await migrate(db.conn);
    // baseline uses IF NOT EXISTS, so it applies cleanly and is recorded.
    expect(await appliedVersions()).toContain("0001_init");
  });
});
