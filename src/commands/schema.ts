import { EMBED_DIM, EMBED_MODEL, resolveVault } from "../config.ts";
import { formatRows, type OutputFormat, type Row } from "../output.ts";
import { openDb } from "../storage/db.ts";

export interface SchemaOptions {
  vault?: string;
  json: boolean;
}

interface TableSchema {
  name: string;
  columns: { name: string; type: string; nullable: boolean }[];
  constraints: { type: string; columns: string[] }[];
}

const TABLES = ["memory", "memory_chunks"];

// vss functions + the meml_embed preprocessor pseudo-function. The latter is not a real DuckDB
// function — it only works inside `meml sql`, which embeds the literal and binds a query vector.
const FUNCTIONS = [
  {
    name: "array_cosine_similarity",
    signature: `array_cosine_similarity(a FLOAT[${EMBED_DIM}], b FLOAT[${EMBED_DIM}]) -> FLOAT`,
    source: "vss",
    note: "Cosine similarity in [-1, 1]; higher is closer. Both args must be same-dim ARRAYs.",
  },
  {
    name: "array_distance",
    signature: `array_distance(a FLOAT[${EMBED_DIM}], b FLOAT[${EMBED_DIM}]) -> FLOAT`,
    source: "vss",
    note: "Euclidean (L2) distance; lower is closer.",
  },
  {
    name: "array_inner_product",
    signature: `array_inner_product(a FLOAT[${EMBED_DIM}], b FLOAT[${EMBED_DIM}]) -> FLOAT`,
    source: "vss",
    note: "Dot product.",
  },
  {
    name: "meml_embed",
    signature: `meml_embed('text') -> FLOAT[${EMBED_DIM}]`,
    source: "meml (preprocessor)",
    note: "Only valid inside `meml sql`. The string literal is embedded once and bound as a query vector. Column arguments are not supported.",
  },
];

export async function cmdSchema(opts: SchemaOptions): Promise<void> {
  const vault = resolveVault(opts.vault);
  const db = await openDb(vault, "read-only");
  try {
    const colsRes = await db.conn.runAndReadAll(`
      SELECT table_name, column_name, data_type, is_nullable
      FROM duckdb_columns()
      WHERE table_name IN ('memory', 'memory_chunks')
      ORDER BY table_name, column_index
    `);
    const consRes = await db.conn.runAndReadAll(`
      SELECT table_name, constraint_type, constraint_column_names
      FROM duckdb_constraints()
      WHERE table_name IN ('memory', 'memory_chunks')
      ORDER BY table_name
    `);

    const cols = colsRes.getRowObjectsJson() as unknown as {
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: boolean;
    }[];
    const cons = consRes.getRowObjectsJson() as unknown as {
      table_name: string;
      constraint_type: string;
      constraint_column_names: string[];
    }[];

    const tables: TableSchema[] = TABLES.map((t) => ({
      name: t,
      columns: cols
        .filter((c) => c.table_name === t)
        .map((c) => ({ name: c.column_name, type: c.data_type, nullable: !!c.is_nullable })),
      constraints: cons
        .filter((c) => c.table_name === t)
        .map((c) => ({ type: c.constraint_type, columns: c.constraint_column_names })),
    }));

    const schema = { tables, functions: FUNCTIONS, embedding: { model: EMBED_MODEL, dim: EMBED_DIM } };

    // Honor the global output contract: JSON when piped (non-TTY / agent), human table on a TTY.
    // --json forces JSON.
    const asJson = opts.json || !process.stdout.isTTY;
    if (asJson) {
      process.stdout.write(JSON.stringify(schema, null, process.stdout.isTTY ? 2 : 0) + "\n");
    } else {
      process.stdout.write(renderHuman(tables) + "\n");
    }
  } finally {
    db.close();
  }
}

function renderHuman(tables: TableSchema[]): string {
  const parts: string[] = [];
  for (const t of tables) {
    parts.push(`TABLE ${t.name}`);
    const rows: Row[] = t.columns.map((c) => ({ column: c.name, type: c.type, nullable: c.nullable }));
    parts.push(formatRows(rows, "table" as OutputFormat));
    if (t.constraints.length > 0) {
      parts.push(
        "constraints: " + t.constraints.map((c) => `${c.type}(${c.columns.join(", ")})`).join(", "),
      );
    }
    parts.push("");
  }
  parts.push("FUNCTIONS");
  for (const f of FUNCTIONS) parts.push(`  ${f.signature}  [${f.source}]`);
  return parts.join("\n");
}
