import { MemlError } from "../errors.ts";
import { dollarQuoteEnd } from "./scan.ts";

// Statement-level keywords that imply a write or a side effect (file IO, extension load,
// attach, settings). The read_only connection is the hard backstop; this denylist is
// defense-in-depth and gives a clear error instead of an opaque engine failure.
const FORBIDDEN = [
  "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "ATTACH", "DETACH",
  "COPY", "INSTALL", "LOAD", "PRAGMA", "CALL", "SET", "RESET", "EXPORT", "IMPORT",
  "VACUUM", "CHECKPOINT", "TRUNCATE", "MERGE", "GRANT", "REVOKE", "ANALYZE", "USE",
];

// Enforce: single statement, starting with SELECT or WITH, with no write/side-effect keyword.
// String literals and comments are neutralized first so keywords inside them don't false-trip.
export function assertReadOnlySql(sql: string): void {
  const stripped = stripLiteralsAndComments(sql);
  const trimmed = stripped.trim().replace(/;+\s*$/, "");
  if (trimmed === "") {
    throw new MemlError("SQL_ERROR", "empty SQL statement", "Provide a SELECT or WITH query.");
  }
  if (trimmed.includes(";")) {
    throw new MemlError(
      "SQL_FORBIDDEN",
      "multiple statements are not allowed",
      "Run a single SELECT/WITH statement per `meml sql` invocation.",
    );
  }
  const first = (/^\s*([a-zA-Z_]+)/.exec(trimmed)?.[1] ?? "").toUpperCase();
  if (first !== "SELECT" && first !== "WITH") {
    throw new MemlError(
      "SQL_FORBIDDEN",
      `only SELECT/WITH queries are allowed (got "${first || "?"}")`,
      "`meml sql` is read-only. Use `meml add` / `meml remove` to modify data.",
    );
  }
  const upper = trimmed.toUpperCase();
  for (const kw of FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`).test(upper)) {
      throw new MemlError(
        "SQL_FORBIDDEN",
        `forbidden keyword "${kw}" in read-only query`,
        "`meml sql` rejects write and side-effecting statements.",
      );
    }
  }
}

// Replace string-literal and comment contents with neutral placeholders. Used only for
// validation; the original SQL (after meml_embed preprocessing) is what gets executed.
export function stripLiteralsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === "-" && c2 === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      out += "''";
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      out += '"_"';
      continue;
    }
    if (c === "$") {
      const dq = dollarQuoteEnd(sql, i);
      if (dq !== null) {
        out += "''";
        i = dq;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}
