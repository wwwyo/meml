import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Migration {
  /** Stable identifier (filename without extension), recorded in schema_migrations. */
  version: string;
  sql: string;
}

// Migration filename convention: <4-digit number>_<lowercase name>.sql (e.g. 0002_add_tags.sql).
const MIGRATION_FILE = /^(\d{4}_[a-z0-9_]+)\.sql$/;

// Auto-collect every migrations/*.sql at load time, ordered by zero-padded filename = apply order.
// Adding a migration = dropping a new .sql file in this directory; there is no registration step to
// forget. A file that breaks the naming convention (or reuses a number) fails loudly here rather
// than being silently skipped or misordered.
//
// This reads sibling .sql files from disk at runtime, which is correct because meml runs from
// source (package.json bin -> ./src/index.ts). If meml is ever shipped as a `bun build --compile`
// standalone binary, sibling files won't exist on disk next to the binary — switch to embedded
// imports (`import sql from "./0001.sql" with { type: "text" }`) at that point.
function loadMigrations(): Migration[] {
  const dir = import.meta.dir;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const seenNumbers = new Set<string>();
  return files.map((file) => {
    const match = MIGRATION_FILE.exec(file);
    if (!match) {
      throw new Error(`migration "${file}" must be named <NNNN>_<name>.sql (e.g. 0002_add_tags.sql)`);
    }
    const version = match[1]!;
    const number = version.slice(0, 4);
    if (seenNumbers.has(number)) {
      throw new Error(`duplicate migration number ${number} (file ${file})`);
    }
    seenNumbers.add(number);
    return { version, sql: readFileSync(join(dir, file), "utf8") };
  });
}

export const MIGRATIONS: Migration[] = loadMigrations();
