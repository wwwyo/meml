import { DuckDBArrayType, FLOAT } from "@duckdb/node-api";
import { EMBED_DIM, resolveVault } from "../config.ts";
import { getEngine } from "../embedding/index.ts";
import { MemlError } from "../errors.ts";
import { formatRows, type OutputFormat, type Row } from "../output.ts";
import { assertReadOnlySql } from "../sql/guard.ts";
import { preprocessEmbed } from "../sql/preprocess.ts";
import { openDb } from "../storage/db.ts";

const FLOAT_ARRAY = new DuckDBArrayType(FLOAT, EMBED_DIM);

export interface SqlOptions {
  query: string;
  vault?: string;
  format: OutputFormat;
}

// Execute a read-only query. Pipeline: meml_embed preprocessing -> statement allowlist guard ->
// embed query literals once -> bind as FLOAT[] params -> run on a read_only connection.
export async function cmdSql(opts: SqlOptions): Promise<void> {
  const raw = opts.query === "-" ? await Bun.stdin.text() : opts.query;
  if (raw.trim() === "") {
    throw new MemlError("SQL_ERROR", "empty SQL", "Provide a query argument or pipe SQL via `-`.");
  }

  const { sql, params } = preprocessEmbed(raw);
  assertReadOnlySql(sql);

  const vectors = params.length > 0 ? await getEngine().embed(params.map((p) => p.text)) : [];

  const vault = resolveVault(opts.vault);
  const db = await openDb(vault, "read-only");
  try {
    const stmt = await db.conn.prepare(sql).catch((e) => {
      throw new MemlError("SQL_ERROR", (e as Error).message);
    });
    params.forEach((p, idx) => {
      const pIndex = stmt.parameterIndex(p.name);
      stmt.bindArray(pIndex, Array.from(vectors[idx]!), FLOAT_ARRAY);
    });

    let rows: Row[];
    try {
      const reader = await stmt.runAndReadAll();
      rows = reader.getRowObjectsJson() as unknown as Row[];
    } catch (e) {
      throw new MemlError("SQL_ERROR", (e as Error).message);
    }
    process.stdout.write(formatRows(rows, opts.format) + "\n");
  } finally {
    db.close();
  }
}
