import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, openDb } from "../src/storage/db.ts";
import { migrate } from "../src/storage/migrate.ts";

// The read-only connection (used by `meml sql`) must block filesystem/external access at the
// engine level — the keyword allowlist cannot enumerate DuckDB's table functions.
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "meml-sec-"));
  const rw = await openDb(dir, "read-write");
  await migrate(rw.conn);
  rw.close();
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function expectBlocked(ro: Db, sql: string) {
  let threw = false;
  try {
    await ro.conn.run(sql);
  } catch (e) {
    threw = true;
    expect((e as Error).message).toContain("disabled by configuration");
  }
  expect(threw).toBe(true);
}

describe("read-only connection lockdown", () => {
  test("blocks file reads, nested query() file reads, and COPY TO; allows normal queries", async () => {
    const ro = await openDb(dir, "read-only");
    try {
      await expectBlocked(ro, "SELECT * FROM read_text('/etc/hosts')");
      await expectBlocked(ro, "SELECT * FROM query('SELECT * FROM read_text(''/etc/hosts'')')");
      await expectBlocked(ro, `COPY (SELECT 1) TO '${dir}/exfil.csv' (FORMAT CSV)`);

      const r = await ro.conn.runAndReadAll("SELECT count(*) AS n FROM memory");
      expect((r.getRowObjectsJson()[0] as { n: string }).n).toBe("0");
    } finally {
      ro.close();
    }
  });
});
