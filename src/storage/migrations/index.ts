import sql0001 from "./0001_init.sql" with { type: "text" };

export interface Migration {
  /** Stable identifier, recorded in schema_migrations. Order = apply order. */
  version: string;
  sql: string;
}

// Ordered list of migrations. Append new entries; never edit or reorder shipped ones.
// .sql files are imported as text so they stay reviewable as raw SQL and bundle cleanly.
export const MIGRATIONS: Migration[] = [{ version: "0001_init", sql: sql0001 }];
