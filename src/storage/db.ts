import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import { dbPath } from "../config.ts";
import { MemlError } from "../errors.ts";

export type Mode = "read-write" | "read-only";

export interface Db {
  conn: DuckDBConnection;
  close(): void;
}

// read-only opens with engine-enforced write protection (defense-in-depth for `meml sql`);
// read-write is used by ingest commands.
export async function openDb(vault: string, mode: Mode): Promise<Db> {
  const path = dbPath(vault);
  if (mode === "read-only" && !existsSync(path)) {
    throw new MemlError(
      "NOT_INITIALIZED",
      `vault not initialized at ${vault}`,
      "Run `meml init` first (optionally with --vault).",
    );
  }
  const options = mode === "read-only" ? { access_mode: "READ_ONLY" } : undefined;
  let instance: DuckDBInstance;
  try {
    instance = await DuckDBInstance.create(path, options);
  } catch (e) {
    throw new MemlError("IO_ERROR", `failed to open DB at ${path}: ${(e as Error).message}`);
  }
  const conn = await instance.connect();
  if (mode === "read-only") {
    // Engine-level lockdown for the agent-facing `meml sql` surface: blocks file IO
    // (read_csv/read_text/glob/COPY TO), ATTACH, INSTALL/LOAD, and network. The keyword
    // allowlist cannot enumerate DuckDB's open-ended table functions (e.g. query()), so this
    // is the real backstop. The flag is one-way (cannot be re-enabled) for the lifetime of
    // the connection.
    await conn.run("SET enable_external_access = false");
  }
  return {
    conn,
    close() {
      conn.closeSync();
      instance.closeSync();
    },
  };
}
