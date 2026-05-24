import { existsSync } from "node:fs";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { dbPath } from "../config.ts";
import { MemlError } from "../errors.ts";

export type Mode = "read-write" | "read-only";

export interface Db {
  conn: DuckDBConnection;
  close(): void;
}

// Open the vault DB and load the vss extension. read-only opens with engine-enforced
// write protection (defense-in-depth for `meml sql`); read-write is used by ingest commands.
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
  // Only the read-write path (init / add / remove) installs the extension; read-only just loads
  // the already-cached one, keeping the agent query path free of network/install side effects.
  await loadVss(conn, mode === "read-write");
  if (mode === "read-only") {
    // Engine-level lockdown for the agent-facing `meml sql` surface: blocks file IO
    // (read_csv/read_text/glob/COPY TO), ATTACH, INSTALL/LOAD, and network. The keyword
    // allowlist cannot enumerate DuckDB's open-ended table functions (e.g. query()), so this
    // is the real backstop. Must run AFTER LOAD vss (loading an extension is external access);
    // the flag is one-way (cannot be re-enabled) for the lifetime of the connection.
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

async function loadVss(conn: DuckDBConnection, install: boolean): Promise<void> {
  try {
    if (install) await conn.run("INSTALL vss");
    await conn.run("LOAD vss");
  } catch (e) {
    throw new MemlError(
      "IO_ERROR",
      `failed to load DuckDB vss extension: ${(e as Error).message}`,
      install
        ? "Ensure network access for the first INSTALL vss, or that the extension is already cached."
        : "Run `meml init` to install the vss extension.",
    );
  }
}
