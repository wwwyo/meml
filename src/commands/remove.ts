import { existsSync } from "node:fs";
import { dbPath, resolveVault } from "../config.ts";
import { MemlError } from "../errors.ts";
import { formatResult, type OutputFormat } from "../output.ts";
import { toSourceId } from "../paths.ts";
import { openDb } from "../storage/db.ts";
import { removeBySourceId } from "../storage/repo.ts";

export interface RemoveOptions {
  path: string;
  vault?: string;
  format: OutputFormat;
}

// Delete a md memory by resolved path. The only write path for `meml sql` (read-only) gaps:
// fixing a mis-ingest, or cleaning a rename orphan whose file no longer exists.
export async function cmdRemove(opts: RemoveOptions): Promise<void> {
  const sourceId = toSourceId(opts.path);
  const vault = resolveVault(opts.vault);
  if (!existsSync(dbPath(vault))) {
    throw new MemlError("NOT_INITIALIZED", `vault not initialized at ${vault}`, "Run `meml init` first.");
  }

  const db = await openDb(vault, "read-write");
  try {
    await db.conn.run("BEGIN TRANSACTION");
    let id: string | null;
    try {
      id = await removeBySourceId(db.conn, "md", sourceId);
      await db.conn.run("COMMIT");
    } catch (e) {
      await db.conn.run("ROLLBACK").catch(() => {});
      throw e;
    }
    if (id === null) {
      throw new MemlError(
        "NOT_FOUND",
        `no memory found for path: ${sourceId}`,
        "List ingested paths with: meml sql \"SELECT source_id FROM memory WHERE source='md'\"",
      );
    }
    process.stdout.write(formatResult({ removed: true, id, source_id: sourceId }, opts.format) + "\n");
  } finally {
    db.close();
  }
}
